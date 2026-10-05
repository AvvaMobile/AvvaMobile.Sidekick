import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitSnapshot } from '../../../domain/review/reviewPacket';
import type { WorkspaceRecord } from '../../../domain/workspace/workspace';
import type { AdapterResult, ClaudePromptCandidate } from '../../chatgpt/ChatGPTAdapter';
import type { ClaudeRunRequest } from '../../claude/ClaudeRunner';
import { DevelopmentPaneRegistry } from '../../development/DevelopmentPane';
import { DEFAULT_PROMPT_SUFFIX } from '../../../domain/handoff/promptSuffix';
import { AppStateStore } from '../AppStateStore';
import { WorkspaceOrchestrator, type TaskFinishedNotice } from '../WorkspaceOrchestrator';

/** Lets pending work (incl. an automatic handback that waits on 0 ms timers) run to its end. */
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function record(id: string, projectPath: string, extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id,
    name: `Project ${id}`,
    projectPath,
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: null,
    sidebarColor: '#123456',
    sidebarOrder: 0,
    chatConversationUrl: null,
    claudeSessionId: null,
    uiState: { splitRatio: 0.6 },
    lastTaskId: null,
    ...extra,
  };
}

const ok = (text: string, messageId = 'msg-1'): AdapterResult<ClaudePromptCandidate> => ({
  ok: true,
  value: { text, messageId, conversationUrl: 'https://chatgpt.com/c/x', truncated: false, capturedAt: '' },
});

function fakeChat(block: () => AdapterResult<ClaudePromptCandidate>) {
  const chat = {
    inserted: [] as string[],
    submitted: 0,
    /** The user's latest ChatGPT message (auto-send trigger detection). */
    userMessage: 'Write a prompt for the login screen.',
    /** The conversation the ChatGPT view shows right now, and whether it can be navigated back to another one. */
    currentUrl: 'https://chatgpt.com/c/x' as string,
    canRestore: true,
    /** Conversation each insert landed in. */
    insertedAt: [] as string[],
    ensureConversation: vi.fn(async (url: string | null): Promise<AdapterResult<{ restored: boolean }>> => {
      if (!url) return { ok: false, code: 'conversation_unavailable', detail: 'unknown' };
      if (url === chat.currentUrl) return { ok: true, value: { restored: false } };
      if (!chat.canRestore) return { ok: false, code: 'conversation_unavailable', detail: 'gone' };
      chat.currentUrl = url;
      return { ok: true, value: { restored: true } };
    }),
    getLatestClaudePromptBlock: vi.fn(async () => block()),
    getLatestUserMessage: vi.fn(async (): Promise<AdapterResult<{ text: string; messageId: string | null }>> => ({ ok: true, value: { text: chat.userMessage, messageId: 'u-1' } })),
    insertComposerText: vi.fn(async (text: string): Promise<AdapterResult<{ inserted: number }>> => {
      chat.inserted.push(text);
      chat.insertedAt.push(chat.currentUrl);
      return { ok: true, value: { inserted: text.length } };
    }),
    submitComposer: vi.fn(async (): Promise<AdapterResult<{ via: string }>> => {
      chat.submitted++;
      return { ok: true, value: { via: 'send-button' } };
    }),
  };
  return chat;
}

const gitSnap = (phase: 'before' | 'after'): GitSnapshot => ({
  phase,
  capturedAt: '',
  isRepo: true,
  branch: 'main',
  headSha: 'aaaa',
  statusShort: '',
  changedFiles: phase === 'after' ? ['M src/x.ts'] : [],
  diffStat: phase === 'after' ? ' src/x.ts | 2 +-' : null,
  diffExcerpt: null,
  truncated: false,
  error: null,
});

describe('WorkspaceOrchestrator', () => {
  let store: AppStateStore;
  let panes: DevelopmentPaneRegistry;
  let runs: ClaudeRunRequest[];
  let cancels: number;
  let notices: TaskFinishedNotice[];
  let chats: Record<string, ReturnType<typeof fakeChat>>;
  let blocks: Record<string, AdapterResult<ClaudePromptCandidate>>;
  let foreground: string | null;
  let orch: WorkspaceOrchestrator;
  let stateFile: string;

  beforeEach(() => {
    stateFile = join(mkdtempSync(join(tmpdir(), 'ws-orch-')), 'state.json');
    store = new AppStateStore(stateFile, 0);
    store.addWorkspace(record('a', '/tmp/project-a'));
    store.addWorkspace(record('b', '/tmp/project-b', { claudeSessionId: 'session-b' }));
    panes = new DevelopmentPaneRegistry();
    runs = [];
    cancels = 0;
    notices = [];
    blocks = { a: ok('Prompt for A'), b: ok('Prompt for B', 'msg-b') };
    chats = { a: fakeChat(() => blocks.a!), b: fakeChat(() => blocks.b!) };
    foreground = 'a';
    let n = 0;
    orch = new WorkspaceOrchestrator({
      store,
      panes,
      runner: {
        start: (req) => {
          runs.push(req);
          return { cancel: () => cancels++ };
        },
      },
      git: { snapshot: async (_cwd, phase) => gitSnap(phase) },
      chatFor: (id) => chats[id] ?? null,
      isForeground: (id) => id === foreground,
      notifyTaskFinished: (n) => notices.push(n),
      onChange: () => {},
      handbackWait: { intervalMs: 0, maxWaits: 1 },
      newId: () => `id-${++n}`,
    });
    orch.register('a');
    orch.register('b');
    orch.setClaudePromptSuffix(''); // the Append-to-Claude-prompts tests set their own
  });

  /** A candidate is accepted once the same block is observed on two consecutive polls. */
  function seen(ws: string, res: AdapterResult<ClaudePromptCandidate>) {
    orch.observeCandidate(ws, res);
    orch.observeCandidate(ws, res);
  }

  /** ChatGPT refuses the handback (message box has a draft that never clears). */
  const failDelivery = (ws: string) => chats[ws]!.insertComposerText.mockResolvedValue({ ok: false, code: 'composer_not_empty', detail: '' });
  const allowDelivery = (ws: string) =>
    chats[ws]!.insertComposerText.mockImplementation(async (text: string) => {
      chats[ws]!.inserted.push(text);
      chats[ws]!.insertedAt.push(chats[ws]!.currentUrl);
      return { ok: true, value: { inserted: text.length } };
    });

  async function startTask(ws: string): Promise<ClaudeRunRequest> {
    const res = await orch.sendToClaude(ws, 'button');
    if (!res.ok) throw new Error(res.detail);
    await flush();
    return runs[runs.length - 1]!;
  }

  function complete(req: ClaudeRunRequest, result = 'Done.', isError = false) {
    req.onEvent({ type: 'init', sessionId: `session-${req.workspaceId}-new` });
    req.onEvent({ type: 'result', isError, subtype: isError ? 'error_during_execution' : 'success', result, sessionId: `session-${req.workspaceId}-new` });
    req.onExit({ code: isError ? 1 : 0, signal: null, spawnError: null });
  }

  it('Send to Claude is unavailable without a candidate and available with one', () => {
    expect(orch.view('a')!.candidate).toBeNull();
    orch.observeCandidate('a', { ok: false, code: 'no_prompt_block', detail: '' });
    expect(orch.view('a')!.candidate).toBeNull();
    orch.observeCandidate('a', ok('Do the thing'));
    expect(orch.view('a')!.candidate).toBeNull(); // may still be streaming
    orch.observeCandidate('a', ok('Do the thing'));
    expect(orch.view('a')!.candidate).toMatchObject({ text: 'Do the thing', alreadySent: false });
  });

  it('a block that keeps changing (streaming) never becomes the candidate', () => {
    for (let i = 0; i < 10; i++) orch.observeCandidate('a', ok(`Do the thing ${'.'.repeat(i)}`));
    expect(orch.view('a')!.candidate).toBeNull();
  });

  it('normal ChatGPT messages (DOM observation) never launch Claude', async () => {
    for (let i = 0; i < 50; i++) {
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      orch.observeCandidate('a', ok(`reply ${i}`));
    }
    await flush();
    expect(runs).toHaveLength(0);
    expect(orch.view('a')!.task).toBeNull();
  });

  it('one click: the freshly captured Claude Prompt block becomes Task.prompt and Claude starts', async () => {
    seen('a', ok('Old observed block'));
    blocks.a = ok('Prompt for A (latest)', 'msg-2');
    const r = await orch.sendToClaude('a', 'button');
    expect(r.ok).toBe(true);
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toBe('Prompt for A (latest)');
    expect(orch.view('a')!.task!.prompt).toBe('Prompt for A (latest)');
  });

  it('nothing starts when there is no Claude Prompt block', async () => {
    blocks.a = { ok: false, code: 'no_prompt_block', detail: '' };
    const r = await orch.sendToClaude('a', 'button');
    expect(r.ok).toBe(false);
    await flush();
    expect(runs).toHaveLength(0);
    expect(orch.view('a')!.task).toBeNull();
  });

  it('duplicate clicks do not create duplicate tasks', async () => {
    const [r1, r2] = await Promise.all([orch.sendToClaude('a', 'button'), orch.sendToClaude('a', 'button')]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    expect((await orch.sendToClaude('a', 'button')).ok).toBe(false); // still running
    await flush();
    expect(runs).toHaveLength(1);
    expect(store.get().tasks).toHaveLength(1);
  });

  it('task belongs to the selected Workspace: its cwd, its session, its candidate', async () => {
    const req = await startTask('b');
    expect(req.workspaceId).toBe('b');
    expect(req.cwd).toBe('/tmp/project-b');
    expect(req.resumeSessionId).toBe('session-b');
    expect(req.prompt).toBe('Prompt for B');
    expect(orch.view('a')!.task).toBeNull();
    complete(req);
    await flush();
    expect(store.workspace('b')!.claudeSessionId).toBe('session-b-new');
    expect(store.workspace('a')!.claudeSessionId).toBeNull();
  });

  it('candidate prompt state is isolated per Workspace', () => {
    seen('a', ok('only A'));
    orch.observeCandidate('b', { ok: false, code: 'no_prompt_block', detail: '' });
    expect(orch.view('a')!.candidate?.text).toBe('only A');
    expect(orch.view('b')!.candidate).toBeNull();
    seen('b', ok('only B'));
    expect(orch.view('a')!.candidate?.text).toBe('only A');
  });

  it("a managed task never writes into any Workspace's terminal buffer", async () => {
    panes.writeOutput('b', 'pty', 'b-shell$ ');
    const req = await startTask('a');
    complete(req, 'All good');
    await flush();
    expect(panes.snapshot('a')).toBe('');
    expect(panes.snapshot('b')).toBe('b-shell$ ');
  });

  it('manual terminal activity does not alter managed task state', async () => {
    const pty = { write: vi.fn() };
    panes.attachPty('a', pty);
    const req = await startTask('a');
    const before = JSON.stringify(orch.view('a')!.task);
    panes.writeUserInput('a', 'claude\r');
    panes.writeOutput('a', 'pty', '$ \r\n> done\r\n$ ');
    await flush();
    expect(JSON.stringify(orch.view('a')!.task)).toBe(before);
    expect(orch.view('a')!.task!.status).toBe('running');
    complete(req);
    await flush();
    expect(orch.view('a')!.task!.status).toBe('review_sent');
  });

  it('completion builds the review packet and hands it to ChatGPT by itself — no click', async () => {
    foreground = 'b'; // a finishes in the background
    const req = await startTask('a');
    complete(req, 'Implemented X');
    await flush();
    const view = orch.view('a')!;
    expect(view.task!.status).toBe('review_sent');
    expect(view.task!.outcome).toBe('succeeded');
    expect(view.task!.review).toMatchObject({ status: 'sent', lastError: null });
    expect(view.task!.review!.body).toContain('Implemented X');
    expect(view.task!.review!.body).toContain('M src/x.ts');
    expect(chats.a!.inserted).toHaveLength(1);
    expect(chats.a!.inserted[0]).toContain('M src/x.ts');
    expect(chats.a!.submitted).toBe(1);
    expect(view.latestReview).toBeNull();
    expect(view.attention).toBe('none');
    expect(notices).toEqual([expect.objectContaining({ workspaceId: 'a', background: true, kind: 'success' })]);
    expect(runs).toHaveLength(1);
  });

  it('the result goes only to the originating Workspace and its source conversation', async () => {
    const reqA = await startTask('a');
    const reqB = await startTask('b');
    complete(reqA, 'Result A');
    await flush();
    expect(chats.a!.inserted).toHaveLength(1);
    expect(chats.a!.inserted[0]).toContain('Result A');
    expect(chats.b!.inserted).toHaveLength(0);
    complete(reqB, 'Result B');
    await flush();
    expect(chats.b!.inserted).toHaveLength(1);
    expect(chats.b!.inserted[0]).toContain('Result B');
    expect(chats.a!.inserted).toHaveLength(1);
  });

  it('after the user moved to another conversation, the source conversation is restored first; the result never lands in the visible one', async () => {
    const req = await startTask('a'); // started from https://chatgpt.com/c/x
    chats.a!.currentUrl = 'https://chatgpt.com/c/other';
    complete(req, 'Result A');
    await flush();
    expect(chats.a!.ensureConversation).toHaveBeenCalledWith('https://chatgpt.com/c/x');
    expect(chats.a!.insertedAt).toEqual(['https://chatgpt.com/c/x']);
    expect(orch.view('a')!.task!.status).toBe('review_sent');
  });

  it('an unrestorable source conversation fails safely: nothing inserted, packet kept, Retry offered', async () => {
    const req = await startTask('a');
    chats.a!.currentUrl = 'https://chatgpt.com/c/other';
    chats.a!.canRestore = false;
    complete(req, 'Result A');
    await flush();
    expect(chats.a!.inserted).toHaveLength(0);
    expect(chats.a!.submitted).toBe(0);
    const v = orch.view('a')!;
    expect(v.task!.status).toBe('review_pending');
    expect(v.latestReview).toMatchObject({ status: 'failed', lastError: expect.stringContaining('conversation') });
    expect(v.latestReview!.body).toContain('Result A');
    expect(runs).toHaveLength(1);
    // Retry: the conversation is reachable again.
    chats.a!.canRestore = true;
    expect((await orch.retryReview('a', v.latestReview!.taskId)).ok).toBe(true);
    expect(chats.a!.insertedAt).toEqual(['https://chatgpt.com/c/x']);
    expect(orch.view('a')!.task!.status).toBe('review_sent');
    expect(runs).toHaveLength(1);
  });

  it('a task without a known source conversation is never delivered to a guess', async () => {
    blocks.a = { ok: true, value: { text: 'P', messageId: 'm1', conversationUrl: null, truncated: false, capturedAt: '' } };
    const req = await startTask('a');
    complete(req);
    await flush();
    expect(chats.a!.inserted).toHaveLength(0);
    expect(orch.view('a')!.latestReview!.status).toBe('failed');
  });

  it('the user keeps chatting while Claude runs: the handback waits for the reply to finish, then goes through', async () => {
    const req = await startTask('a');
    orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
    complete(req, 'Result A');
    orch.observeCandidate('a', ok('the reply', 'msg-9')); // ChatGPT finishes while the handback waits
    await flush();
    expect(chats.a!.submitted).toBe(1);
    expect(orch.view('a')!.task!.status).toBe('review_sent');
  });

  it('if ChatGPT never stops replying the result is kept with a Retry, not lost', async () => {
    const req = await startTask('a');
    orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
    complete(req, 'Result A');
    await flush();
    expect(chats.a!.inserted).toHaveLength(0);
    expect(orch.view('a')!.latestReview).toMatchObject({ status: 'failed', lastError: expect.stringContaining('still responding') });
    orch.observeCandidate('a', ok('reply', 'msg-9'));
    expect((await orch.retryReview('a', orch.view('a')!.latestReview!.taskId)).ok).toBe(true);
    expect(chats.a!.submitted).toBe(1);
  });

  it('a draft the user is typing is never overwritten; it waits, then fails and keeps the packet', async () => {
    failDelivery('a');
    const req = await startTask('a');
    complete(req, 'Result A');
    await flush();
    expect(chats.a!.insertComposerText.mock.calls.length).toBeGreaterThan(1); // waited and tried again
    expect(chats.a!.submitted).toBe(0);
    expect(orch.view('a')!.task!.review).toMatchObject({ status: 'failed', lastError: expect.stringContaining('message box') });
  });

  it('failed handback keeps the packet; Retry delivers only the stored result and never re-runs Claude', async () => {
    failDelivery('a');
    const req = await startTask('a');
    complete(req);
    await flush();
    const v = orch.view('a')!;
    expect(v.task!.status).toBe('review_pending');
    expect(v.task!.review).toMatchObject({ status: 'failed', lastError: expect.any(String) });
    expect(runs).toHaveLength(1);
    expect(store.get().tasks).toHaveLength(1);
    allowDelivery('a');
    const r2 = await orch.retryReview('a', v.latestReview!.taskId);
    expect(r2.ok).toBe(true);
    expect(orch.view('a')!.task!.review).toMatchObject({ status: 'sent', lastError: null });
    expect(chats.a!.inserted[0]).toContain(v.latestReview!.body);
    expect(runs).toHaveLength(1);
    expect(store.get().tasks).toHaveLength(1);
  });

  it('Retry only exists for a failed delivery', async () => {
    const req = await startTask('a');
    complete(req);
    await flush();
    const taskId = orch.view('a')!.task!.id;
    expect(await orch.retryReview('a', taskId)).toMatchObject({ ok: false, code: 'not_failed' });
    expect(await orch.retryReview('b', taskId)).toMatchObject({ ok: false, code: 'unknown_task' });
    expect(chats.a!.submitted).toBe(1);
  });

  it('a failed or cancelled Claude task is not handed back automatically', async () => {
    const req = await startTask('a');
    req.onExit({ code: 1, signal: null, spawnError: null });
    await flush();
    expect(orch.view('a')!.task!.outcome).toBe('failed');
    expect(chats.a!.inserted).toHaveLength(0);
  });

  it("the user's own (manual) Claude turns are never handed back to ChatGPT", async () => {
    orch.observeClaudeStop('a');
    orch.observeClaudeStop('a');
    await flush();
    expect(chats.a!.inserted).toHaveLength(0);
    expect(chats.a!.submitted).toBe(0);
    expect(orch.view('a')!.task).toBeNull();
  });

  it('a delivery cut short by quitting the app is kept as failed so Retry appears after the restart', async () => {
    const req = await startTask('a');
    complete(req, 'Result A');
    await flush();
    const taskId = orch.view('a')!.task!.id;
    // Simulate a quit before the packet was sent: back to pending.
    const task = store.task(taskId)!;
    const packet = store.reviewPacket(task.reviewPacketId)!;
    packet.deliveryStatus = 'pending';
    store.putReviewPacket(packet);
    (task as { status: string }).status = 'review_pending';
    store.putTask(task);
    orch.unregister('a');
    orch.register('a');
    expect(orch.view('a')!.latestReview).toMatchObject({ status: 'failed', lastError: expect.stringContaining('interrupted') });
  });

  it('a process exit without a result event is a failure (terminal idleness is never completion)', async () => {
    const req = await startTask('a');
    req.onExit({ code: 0, signal: null, spawnError: null });
    await flush();
    expect(orch.view('a')!.task!.outcome).toBe('failed');
    expect(orch.view('a')!.task!.error).toMatch(/without a final result/);
  });

  it('reports which Workspaces have a running task (quit confirmation)', async () => {
    expect(orch.activeTaskWorkspaceIds()).toEqual([]);
    const req = await startTask('b');
    expect(orch.activeTaskWorkspaceIds()).toEqual(['b']);
    complete(req);
    await flush();
    expect(orch.activeTaskWorkspaceIds()).toEqual([]);
  });

  it('cancel signals the process and records cancelled', async () => {
    const req = await startTask('a');
    expect(orch.cancelTask('a').ok).toBe(true);
    expect(cancels).toBe(1);
    req.onExit({ code: null, signal: 'SIGINT', spawnError: null });
    await flush();
    expect(orch.view('a')!.task!.outcome).toBe('cancelled');
  });

  describe('execution lifecycle', () => {
    const settled: string[] = [];
    beforeEach(() => {
      settled.length = 0;
    });
    const cancelledExit = (req: ClaudeRunRequest) => req.onExit({ code: null, signal: null, spawnError: null, cancelled: true });

    it('completion clears the active execution at once and keeps the result', async () => {
      const req = await startTask('a');
      expect(orch.activeTaskWorkspaceIds()).toEqual(['a']);
      complete(req, 'Result A');
      await flush();
      expect(orch.activeTaskWorkspaceIds()).toEqual([]);
      expect(orch.view('a')!.task!.review!.body).toContain('Result A');
    });

    it('a user interrupt (runner reports cancelled) finalizes the task as cancelled — no stale running state', async () => {
      const req = await startTask('a');
      cancelledExit(req);
      await flush();
      const v = orch.view('a')!;
      expect(v.task!.status).toBe('review_pending');
      expect(v.task!.outcome).toBe('cancelled');
      expect(orch.activeTaskWorkspaceIds()).toEqual([]);
      expect(orch.cancelTask('a')).toMatchObject({ ok: false, code: 'no_active_task' });
    });

    it('the process ending without a result (exit, SIGINT, replaced terminal) finalizes the task as failed', async () => {
      for (const exit of [{ code: 1, signal: null }, { code: null, signal: 'SIGINT' }, { code: null, signal: null }]) {
        const req = await startTask('a');
        req.onExit({ ...exit, spawnError: null });
        await flush();
        expect(orch.view('a')!.task!.outcome).toBe('failed');
        expect(orch.activeTaskWorkspaceIds()).toEqual([]);
        blocks.a = ok(`Prompt ${Math.random()}`, `m-${Math.random()}`);
        seen('a', blocks.a);
      }
    });

    it('STOP (cancel) both signals the runner and ends in cancelled once the runner exits', async () => {
      const req = await startTask('a');
      expect(orch.cancelTask('a').ok).toBe(true);
      cancelledExit(req);
      await flush();
      expect(orch.view('a')!.task!.outcome).toBe('cancelled');
      expect(orch.activeTaskWorkspaceIds()).toEqual([]);
    });

    it('an undelivered result stays available while a later task runs, and the new one replaces it when it completes', async () => {
      failDelivery('a');
      const a1 = await startTask('a');
      complete(a1, 'Result A');
      await flush();
      const firstTask = orch.view('a')!.latestReview!.taskId;
      blocks.a = ok('Second prompt', 'msg-2');
      seen('a', blocks.a);
      const a2 = await startTask('a');
      const during = orch.view('a')!;
      expect(during.task!.status).toBe('running');
      expect(during.latestReview).toMatchObject({ taskId: firstTask, status: 'failed' });
      expect(during.latestReview!.body).toContain('Result A');
      complete(a2, 'Result B');
      await flush();
      expect(orch.view('a')!.latestReview!.body).toContain('Result B');
    });

    it('a cancelled later task does not replace an earlier undelivered result; it can be retried meanwhile', async () => {
      failDelivery('a');
      const a1 = await startTask('a');
      complete(a1, 'Result A');
      await flush();
      const firstTask = orch.view('a')!.latestReview!.taskId;
      blocks.a = ok('Second prompt', 'msg-2');
      seen('a', blocks.a);
      const a2 = await startTask('a');
      // hand the previous result over while the second task is still running
      allowDelivery('a');
      expect((await orch.retryReview('a', firstTask)).ok).toBe(true);
      expect(chats.a!.inserted[0]).toContain('Result A');
      cancelledExit(a2);
      await flush();
      expect(orch.view('a')!.task!.outcome).toBe('cancelled');
    });

    it('a cancelled task alone still offers its own review (nothing earlier to keep)', async () => {
      const req = await startTask('a');
      cancelledExit(req);
      await flush();
      expect(orch.view('a')!.latestReview).toMatchObject({ taskId: orch.view('a')!.task!.id });
    });

    it('Workspaces stay isolated: finishing or cancelling one never touches the other', async () => {
      const ra = await startTask('a');
      const rb = await startTask('b');
      cancelledExit(ra);
      await flush();
      expect(orch.activeTaskWorkspaceIds()).toEqual(['b']);
      expect(orch.view('b')!.task!.status).toBe('running');
      expect(orch.view('b')!.latestReview).toBeNull();
      complete(rb, 'Result B');
      await flush();
      expect(orch.view('a')!.latestReview!.body).not.toContain('Result B');
      expect(chats.a!.inserted).toHaveLength(0);
      expect(chats.b!.inserted).toHaveLength(1);
    });
  });

  describe('one task lifecycle for every view (ChatGPT Focus / Split / Claude Focus)', () => {
    it.each(['chatgpt-focus', 'split', 'claude-focus'] as const)('Send to Claude works while Workspace A is in %s', async (mode) => {
      store.setViewMode('a', mode);
      const req = await startTask('a');
      expect(runs).toHaveLength(1);
      expect(req.prompt).toBe('Prompt for A');
      expect(orch.view('a')!.viewMode).toBe(mode);
      expect(orch.view('a')!.task!.status).toBe('running');
    });

    it('switching views mid-run keeps the same single task running; completion and handback are unaffected', async () => {
      store.setViewMode('a', 'chatgpt-focus');
      const req = await startTask('a');
      const taskId = orch.view('a')!.task!.id;
      for (const mode of ['split', 'claude-focus', 'chatgpt-focus', 'split'] as const) {
        store.setViewMode('a', mode);
        const v = orch.view('a')!;
        expect(v.task!.id).toBe(taskId);
        expect(v.task!.status).toBe('running');
      }
      expect(runs).toHaveLength(1);
      expect(cancels).toBe(0);
      store.setViewMode('a', 'claude-focus');
      complete(req, 'Built it');
      await flush();
      expect(orch.view('a')!.task!.status).toBe('review_sent'); // delivered with the terminal hidden, no click
      store.setViewMode('a', 'chatgpt-focus');
      expect(chats.a!.submitted).toBe(1);
      expect(chats.b!.submitted).toBe(0);
      expect(runs).toHaveLength(1);
    });

    it('views and task state are per Workspace: A running in ChatGPT Focus, B in Claude Focus stays idle, then completes alone', async () => {
      store.setViewMode('a', 'chatgpt-focus');
      store.setViewMode('b', 'claude-focus');
      const reqA = await startTask('a');
      expect(orch.view('a')!.task!.status).toBe('running');
      expect(orch.view('b')!.task).toBeNull();
      expect([orch.view('a')!.viewMode, orch.view('b')!.viewMode]).toEqual(['chatgpt-focus', 'claude-focus']);
      complete(reqA);
      await flush();
      expect(orch.view('a')!.task!.status).toBe('review_sent');
      expect(orch.view('b')!.latestReview).toBeNull();
      expect(orch.view('b')!.task).toBeNull();
      expect(chats.b!.inserted).toHaveLength(0);
    });
  });

  it('reset session is refused while running and clears only this Workspace session', async () => {
    const req = await startTask('b');
    expect(orch.resetSession('b').ok).toBe(false);
    complete(req);
    await flush();
    expect(orch.resetSession('b').ok).toBe(true);
    expect(store.workspace('b')!.claudeSessionId).toBeNull();
  });

  it('a prompt that already ran successfully cannot be re-run by another click', async () => {
    const req = await startTask('a');
    complete(req);
    await flush();
    const r = await orch.sendToClaude('a', 'button');
    expect(r).toMatchObject({ ok: false, code: 'already_sent' });
    blocks.a = ok('A new prompt', 'msg-9');
    expect((await orch.sendToClaude('a', 'button')).ok).toBe(true);
  });

  it('a failed prompt can be re-run', async () => {
    const req = await startTask('a');
    complete(req, 'boom', true);
    await flush();
    expect((await orch.sendToClaude('a', 'button')).ok).toBe(true);
  });

  it('a candidate equal to the last sent prompt is flagged alreadySent', async () => {
    const req = await startTask('a');
    complete(req);
    await flush();
    seen('a', ok('Prompt for A'));
    expect(orch.view('a')!.candidate!.alreadySent).toBe(true);
  });

  describe('flow log (where did I leave off?)', () => {
    const kinds = (ws: string) => (store.workspace(ws)!.flowLog ?? []).map((e) => e.kind);

    it('logs the whole relay: prompt ready, sent, finished, review sent', async () => {
      seen('a', ok('Line one\nline two'));
      const req = await startTask('a');
      complete(req);
      await flush();
      expect(kinds('a')).toEqual(['prompt_ready', 'sent_to_claude', 'claude_finished', 'review_sent']);
      expect(store.workspace('a')!.flowLog![0]!.detail).toBe('Line one');
    });

    it('re-observing the same ChatGPT message does not log a second prompt_ready', () => {
      seen('a', ok('P', 'msg-1'));
      orch.unregister('a');
      orch.register('a');
      seen('a', ok('P', 'msg-1'));
      expect(kinds('a')).toEqual(['prompt_ready']);
    });

    it('logs ChatGPT starting and finishing a reply; a vanished view is not a finished reply', () => {
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      orch.observeCandidate('a', { ok: false, code: 'view_unavailable', detail: '' });
      expect(kinds('a')).toEqual(['chatgpt_started']);
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      orch.observeCandidate('a', { ok: false, code: 'no_prompt_block', detail: '' });
      expect(kinds('a')).toEqual(['chatgpt_started', 'chatgpt_started', 'chatgpt_replied']);
    });

    it("the user's own Claude run is logged and nudges only in the background", () => {
      const nudges: string[] = [];
      foreground = 'b';
      (orch as unknown as { deps: { notifyFlow?: (n: { title: string }) => void } }).deps.notifyFlow = (n) => nudges.push(n.title);
      orch.observeClaudeStop('a');
      expect(kinds('a')).toEqual(['claude_finished']);
      expect(nudges).toEqual(['Project a: Claude finished']);
      foreground = 'a';
      orch.observeClaudeStop('a');
      expect(nudges).toHaveLength(1);
    });

    it('a managed task finishing is not double-logged by the Stop hook', async () => {
      const req = await startTask('a');
      orch.observeClaudeStop('a'); // fires while the managed task is still active
      complete(req);
      await flush();
      expect(kinds('a').filter((k) => k === 'claude_finished')).toHaveLength(1);
    });

    it('a failed handback is logged', async () => {
      failDelivery('a');
      const req = await startTask('a');
      complete(req);
      await flush();
      expect(kinds('a').at(-1)).toBe('review_failed');
    });
  });
  describe('auto-send when the user asked ChatGPT to send it (D034)', () => {
    const ASK = "Tamam, bu promptu Claude'a gönder";
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      chats.a!.userMessage = ASK;
    });
    afterEach(() => vi.useRealTimers());

    async function ready(ws = 'a') {
      seen(ws, blocks[ws]!);
      await tick(0);
    }

    it('a ready prompt is sent after a 3 s countdown when the user asked for it', async () => {
      await ready();
      expect(chats.a!.getLatestUserMessage).toHaveBeenCalledTimes(1);
      const at = orch.view('a')!.autoSend!.at;
      expect(Date.parse(at) - Date.now()).toBeGreaterThan(2_500);
      await tick(2_999);
      expect(runs).toHaveLength(0);
      await tick(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toBe('Prompt for A');
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.task!.status).toBe('running');
    });

    it('nothing is sent when the user did not ask for it', async () => {
      chats.a!.userMessage = 'Bir prompt yaz, sonra bakarız';
      await ready();
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('Cancel stops the countdown', async () => {
      await ready();
      expect(orch.cancelAutoSendRequest('a').ok).toBe(true);
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
      expect(orch.cancelAutoSendRequest('a').ok).toBe(false);
    });

    it('the candidate changing or disappearing cancels the countdown', async () => {
      await ready();
      chats.a!.userMessage = 'Bunu biraz değiştir';
      seen('a', ok('Another prompt', 'msg-2'));
      await tick(0);
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);

      chats.b!.userMessage = 'send it to Claude';
      await ready('b');
      expect(orch.view('b')!.autoSend).not.toBeNull();
      for (let i = 0; i < 3; i++) orch.observeCandidate('b', { ok: false, code: 'no_prompt_block', detail: '' });
      expect(orch.view('b')!.autoSend).toBeNull();
      expect(orch.view('b')!.autoSendNotice!.text).toBe('No Claude prompt ready.');
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('ChatGPT replying does not cancel the countdown; the send waits until ChatGPT is quiet', async () => {
      await ready();
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      expect(orch.view('a')!.autoSend).not.toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0); // still replying: nothing is captured yet
      orch.observeCandidate('a', blocks.a!);
      await tick(1_000);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toBe('Prompt for A');
    });

    it('an explicit Send to Claude during the countdown replaces it (one task only)', async () => {
      await ready();
      await orch.sendToClaude('a', 'button');
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(1);
    });

    it('closing the Workspace cancels the countdown', async () => {
      await ready();
      orch.unregister('a');
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('is off when the setting is off; turning it off cancels a pending countdown', async () => {
      orch.setAutoSendEnabled(false);
      expect(store.preferences().autoSendOnRequest).toBe(false);
      await ready();
      expect(chats.a!.getLatestUserMessage).not.toHaveBeenCalled();
      expect(orch.view('a')!.autoSend).toBeNull();

      orch.setAutoSendEnabled(true);
      chats.b!.userMessage = 'send it to Claude';
      await ready('b');
      expect(orch.view('b')!.autoSend).not.toBeNull();
      orch.setAutoSendEnabled(false);
      expect(orch.view('b')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('the same ChatGPT message is never auto-sent twice', async () => {
      await ready();
      await tick(3_000);
      expect(runs).toHaveLength(1);
      complete(runs[0]!);
      await tick(0);
      orch.unregister('a');
      orch.register('a');
      await ready();
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(1);
    });

    it('after a restart, an already-seen message does not auto-send', async () => {
      orch.setAutoSendEnabled(false);
      await ready(); // seen once (e.g. before the user asked), logged as prompt_ready
      store.flush();
      const store2 = new AppStateStore(stateFile, 0);
      store2.setPreferences({ autoSendOnRequest: true });
      const deps = (orch as unknown as { deps: ConstructorParameters<typeof WorkspaceOrchestrator>[0] }).deps;
      const orch2 = new WorkspaceOrchestrator({ ...deps, store: store2 });
      orch2.register('a');
      orch2.observeCandidate('a', blocks.a!);
      orch2.observeCandidate('a', blocks.a!);
      await tick(0);
      expect(orch2.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });
  });
  describe('intercepted Sidekick command (stopped before ChatGPT saw it, D045)', () => {
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      chats.a!.getLatestUserMessage.mockImplementation(async () => ({ ok: true, value: { text: 'Write a prompt', messageId: 'u-1' } }));
      await orch.observeUserMessage('a'); // baseline
    });
    afterEach(() => vi.useRealTimers());

    it('uses the stored candidate: countdown, then one managed task — also with the terminal hidden (ChatGPT Focus)', async () => {
      store.setViewMode('a', 'chatgpt-focus');
      seen('a', blocks.a!);
      await tick(0);
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      expect(orch.view('a')!.autoSend).not.toBeNull();
      await tick(2_999);
      expect(runs).toHaveLength(0);
      await tick(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toBe('Prompt for A');
      expect(chats.a!.getLatestClaudePromptBlock).toHaveBeenCalled(); // captured fresh at send time
    });

    it('the countdown can be cancelled and nothing starts', async () => {
      seen('a', blocks.a!);
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      expect(orch.cancelAutoSendRequest('a').ok).toBe(true);
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('pressing Enter twice (two intercepted commands) starts one task', async () => {
      seen('a', blocks.a!);
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      orch.observeInterceptedIntent('a', { id: 'i-2' });
      await tick(3_000);
      await tick(0);
      orch.observeInterceptedIntent('a', { id: 'i-3' }); // while running
      await tick(3_000);
      expect(runs).toHaveLength(1);
      expect(orch.view('a')!.autoSendNotice?.text).toMatch(/already working/);
    });

    it('the fallback poll for the same user action cannot start a second task', async () => {
      seen('a', blocks.a!);
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      // The guard failed to stop the message: it reached ChatGPT and the post-submit poll sees it too.
      chats.a!.getLatestUserMessage.mockImplementation(async () => ({ ok: true, value: { text: 'şimdi bunu claude gönder', messageId: 'u-2' } }));
      await orch.observeUserMessage('a');
      await tick(3_000);
      await tick(0);
      await orch.observeUserMessage('a');
      await tick(10_000);
      expect(runs).toHaveLength(1);
    });

    it('no candidate and ChatGPT idle: tells the user, starts nothing', async () => {
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice?.text).toBe('No Claude prompt ready.');
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('no candidate yet but ChatGPT is still writing it: the command waits for that prompt, then counts down', async () => {
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice).toBeNull();
      orch.observeCandidate('a', ok('Fresh prompt', 'msg-5'));
      orch.observeCandidate('a', ok('Fresh prompt', 'msg-5'));
      expect(orch.view('a')!.autoSend).not.toBeNull();
      blocks.a = ok('Fresh prompt', 'msg-5');
      await tick(3_000);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toBe('Fresh prompt');
    });

    it('generic ChatGPT prose never becomes the prompt (a waiting command is not fed by non-prompt replies)', async () => {
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      orch.observeCandidate('a', { ok: false, code: 'no_prompt_block', detail: '' });
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('with auto-send turned off the command is not started and the user is told', async () => {
      seen('a', blocks.a!);
      orch.setAutoSendEnabled(false);
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice?.text).toMatch(/turned off/);
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('stays inside its Workspace', async () => {
      seen('a', blocks.a!);
      seen('b', blocks.b!);
      orch.observeInterceptedIntent('b', { id: 'i-1' });
      await tick(3_000);
      expect(runs.map((r) => r.workspaceId)).toEqual(['b']);
    });

    it('the managed task started by an intercepted command still hands back automatically', async () => {
      seen('a', blocks.a!);
      orch.observeInterceptedIntent('a', { id: 'i-1' });
      await tick(3_000);
      complete(runs[0]!, 'Done by Claude');
      await tick(0);
      await tick(0);
      expect(chats.a!.inserted[0]).toContain('Done by Claude');
      expect(chats.a!.submitted).toBe(1);
    });
  });

  describe('the user message itself triggers auto-send (D034)', () => {
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    const poll = async (ws = 'a') => {
      await orch.observeUserMessage(ws);
    };
    /** The user's latest ChatGPT message changes; one poll reads it. */
    async function userSays(ws: string, text: string, id: string | null) {
      chats[ws]!.getLatestUserMessage.mockImplementation(async () => ({ ok: true, value: { text, messageId: id } }));
      await poll(ws);
    }

    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // Baseline: an earlier message, and a prompt ChatGPT already wrote.
      await userSays('a', 'Write a prompt for the login screen.', 'u-1');
      seen('a', blocks.a!);
      await tick(0);
    });
    afterEach(() => vi.useRealTimers());

    it('"şimdi bunu claude gönder" starts the countdown with the held candidate, no generating transition', async () => {
      await userSays('a', 'şimdi bunu claude gönder', 'u-2');
      expect(orch.view('a')!.autoSend).not.toBeNull();
      await tick(2_999);
      expect(runs).toHaveLength(0);
      await tick(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toBe('Prompt for A');
      expect(orch.view('a')!.task!.status).toBe('running');
    });

    it('whole flow, no click: request -> countdown -> Claude (terminal hidden) -> Project B visited -> result lands in A\'s conversation only', async () => {
      store.setViewMode('a', 'chatgpt-focus');
      await userSays('a', 'şimdi bunu claude gönder', 'u-2');
      await tick(3_000);
      expect(runs).toHaveLength(1);
      // The user chats on, switches to Project B and moves A to another conversation meanwhile.
      foreground = 'b';
      store.setViewMode('a', 'split'); // revealing the terminal changes nothing about the task
      expect(runs).toHaveLength(1);
      expect(cancels).toBe(0);
      chats.a!.currentUrl = 'https://chatgpt.com/c/other';
      complete(runs[0]!, 'Built the login screen');
      await tick(0);
      await tick(0);
      expect(chats.a!.insertedAt).toEqual(['https://chatgpt.com/c/x']);
      expect(chats.a!.inserted[0]).toContain('Built the login screen');
      expect(chats.a!.submitted).toBe(1);
      expect(chats.b!.inserted).toHaveLength(0);
      expect(orch.view('a')!.task!.status).toBe('review_sent');
      expect(runs).toHaveLength(1);
    });

    it('"send this to Claude" starts the countdown', async () => {
      await userSays('a', 'send this to Claude', 'u-2');
      expect(orch.view('a')!.autoSend).not.toBeNull();
    });

    it('the same message seen on many polls gives one countdown and one task', async () => {
      await userSays('a', 'şimdi bunu claude gönder', 'u-2');
      await poll();
      await poll();
      await tick(1_000);
      await poll();
      await tick(2_000);
      await poll();
      await tick(10_000);
      expect(runs).toHaveLength(1);
    });

    it('a ChatGPT reply without a block ("I cannot send it directly") keeps the candidate and the send goes through', async () => {
      await userSays('a', 'şimdi bunu claude gönder', 'u-2');
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      orch.observeCandidate('a', blocks.a!); // reply finished, older block is still the latest one
      expect(orch.view('a')!.candidate!.text).toBe('Prompt for A');
      await tick(3_000);
      expect(runs).toHaveLength(1);
    });

    it('one odd read without a block does not drop the candidate', () => {
      orch.observeCandidate('a', { ok: false, code: 'no_prompt_block', detail: '' });
      orch.observeCandidate('a', { ok: false, code: 'timeout', detail: '' });
      expect(orch.view('a')!.candidate).not.toBeNull();
      orch.observeCandidate('a', blocks.a!);
      orch.observeCandidate('a', { ok: false, code: 'no_prompt_block', detail: '' });
      orch.observeCandidate('a', { ok: false, code: 'no_prompt_block', detail: '' });
      expect(orch.view('a')!.candidate).not.toBeNull(); // the miss count restarted
    });

    it('a message that is not a send request does nothing and shows nothing', async () => {
      await userSays('a', 'Bunu biraz değiştir', 'u-2');
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice).toBeNull();
    });

    it('the first message read after start is only a baseline (no send after a restart)', async () => {
      orch.unregister('a');
      orch.register('a');
      await userSays('a', 'şimdi bunu claude gönder', 'u-9');
      expect(orch.view('a')!.autoSend).toBeNull();
    });

    it('tells the user when there is no prompt', async () => {
      for (let i = 0; i < 3; i++) orch.observeCandidate('a', { ok: false, code: 'no_assistant_messages', detail: '' });
      await userSays('a', 'send this to Claude', 'u-2');
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice!.text).toBe('No Claude prompt ready.');
    });

    it('tells the user when Claude is already working', async () => {
      await orch.sendToClaude('a', 'button');
      await tick(0);
      await userSays('a', 'send this to Claude', 'u-2');
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice!.text).toBe('Claude is already working.');
    });

    it('tells the user when the prompt was already sent', async () => {
      await orch.sendToClaude('a', 'button');
      await tick(0);
      complete(runs[0]!);
      await tick(0);
      await userSays('a', 'send this to Claude', 'u-2');
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice!.text).toBe('This prompt has already been sent.');
    });

    it('tells the user when the prompt changed before it was sent', async () => {
      await userSays('a', 'send this to Claude', 'u-2');
      blocks.a = ok('Prompt for A', 'msg-newer'); // ChatGPT wrote a newer block that the poll has not settled yet
      await tick(3_000);
      expect(runs).toHaveLength(0);
      expect(orch.view('a')!.autoSendNotice!.text).toBe('Claude prompt changed. Please send again.');
    });

    it('Cancel still works and the cancelled request does not start again', async () => {
      await userSays('a', 'send this to Claude', 'u-2');
      orch.cancelAutoSendRequest('a');
      await poll();
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('Workspace A\'s request never sends Workspace B\'s prompt', async () => {
      await userSays('b', 'Write something', 'ub-1');
      seen('b', blocks.b!);
      await userSays('a', 'send this to Claude', 'u-2');
      await tick(3_000);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.workspaceId).toBe('a');
      expect(orch.view('b')!.task).toBeNull();
    });

    it('works with the terminal hidden (ChatGPT Focus) and the same task is there after switching to Split', async () => {
      store.setViewMode('a', 'chatgpt-focus');
      await userSays('a', 'şimdi bunu claude gönder', 'u-2');
      await tick(3_000);
      expect(runs).toHaveLength(1);
      const taskId = orch.view('a')!.task!.id;
      expect(orch.view('a')!.task!.status).toBe('running');
      store.setViewMode('a', 'split');
      const v = orch.view('a')!;
      expect(v.viewMode).toBe('split');
      expect(v.task!.id).toBe(taskId);
      expect(v.task!.status).toBe('running');
      expect(cancels).toBe(0);
      store.setViewMode('a', 'claude-focus');
      expect(orch.view('a')!.task!.id).toBe(taskId);
    });

    it('does nothing when the setting is off', async () => {
      orch.setAutoSendEnabled(false);
      await userSays('a', 'send this to Claude', 'u-2');
      expect(orch.view('a')!.autoSend).toBeNull();
      expect(orch.view('a')!.autoSendNotice).toBeNull();
    });
  });
  it('refuses Send to Claude while the terminal Claude is busy with another turn', async () => {
    const deps = (orch as unknown as { deps: ConstructorParameters<typeof WorkspaceOrchestrator>[0] }).deps;
    let busy = true;
    const o = new WorkspaceOrchestrator({ ...deps, claudeBusy: () => busy });
    o.register('a');
    seen('a', blocks.a!);
    const res = await o.sendToClaude('a', 'button');
    expect(res).toMatchObject({ ok: false, code: 'claude_busy', detail: expect.stringContaining('still working in the terminal') });
    expect(runs).toHaveLength(0);
    busy = false;
    expect((await o.sendToClaude('a', 'button')).ok).toBe(true);
  });

  it('an unexpected error while starting a task fails it instead of leaving it queued', async () => {
    const deps = (orch as unknown as { deps: ConstructorParameters<typeof WorkspaceOrchestrator>[0] }).deps;
    const o = new WorkspaceOrchestrator({
      ...deps,
      runner: {
        start: () => {
          throw new Error('boom');
        },
      },
    });
    o.register('a');
    expect((await o.sendToClaude('a', 'button')).ok).toBe(true);
    await flush();
    expect(o.view('a')!.task).toMatchObject({ status: 'failed', error: expect.stringContaining('boom') });
    expect(o.activeTaskWorkspaceIds()).toEqual([]);
  });

  describe('Append to Claude prompts', () => {
    it('appends the suffix after a blank line; task keeps the original too', async () => {
      orch.setClaudePromptSuffix('Be brief.');
      const req = await startTask('a');
      expect(req.prompt).toBe('Prompt for A\n\nBe brief.');
      expect(orch.view('a')!.task!.prompt).toBe('Prompt for A\n\nBe brief.');
      expect(store.task(orch.view('a')!.task!.id)!.originalPrompt).toBe('Prompt for A');
    });

    it('uses the default suffix on first use', async () => {
      orch.setClaudePromptSuffix(DEFAULT_PROMPT_SUFFIX);
      const req = await startTask('a');
      expect(req.prompt.startsWith('Prompt for A\n\n1. Cevabında')).toBe(true);
    });

    it('an empty or blank suffix leaves the prompt unchanged', async () => {
      orch.setClaudePromptSuffix('');
      expect((await startTask('a')).prompt).toBe('Prompt for A');
      orch.setClaudePromptSuffix(' \n ');
      expect((await startTask('b')).prompt).toBe('Prompt for B');
    });

    it('the same global suffix applies to every Workspace', async () => {
      orch.setClaudePromptSuffix('X');
      expect((await startTask('a')).prompt).toBe('Prompt for A\n\nX');
      expect((await startTask('b')).prompt).toBe('Prompt for B\n\nX');
    });

    it('changing the suffix after the task started does not change its frozen prompt', async () => {
      orch.setClaudePromptSuffix('first');
      const req = await startTask('a');
      orch.setClaudePromptSuffix('second');
      expect(orch.view('a')!.task!.prompt).toBe('Prompt for A\n\nfirst');
      expect(req.prompt).toBe('Prompt for A\n\nfirst');
      expect(store.task(orch.view('a')!.task!.id)!.prompt).toBe('Prompt for A\n\nfirst');
    });

    it('manual terminal input is never modified', async () => {
      const pty = { write: vi.fn() };
      panes.attachPty('a', pty);
      orch.setClaudePromptSuffix('Be brief.');
      panes.writeUserInput('a', 'hello claude\r');
      expect(pty.write).toHaveBeenCalledWith('hello claude\r');
      expect(pty.write.mock.calls.flat().join('')).not.toContain('Be brief.');
    });

    it('the automatic review packet to ChatGPT carries no suffix', async () => {
      orch.setClaudePromptSuffix('SUFFIX-MARKER');
      const req = await startTask('a');
      complete(req);
      await flush();
      expect(chats.a!.inserted[0]).not.toContain('SUFFIX-MARKER');
    });

    it('a prompt that already ran is still recognised after the suffix was appended', async () => {
      const req = await startTask('a');
      complete(req);
      await flush();
      expect(await orch.sendToClaude('a', 'button')).toMatchObject({ ok: false, code: 'already_sent' });
    });
  });
});
