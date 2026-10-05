import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitSnapshot } from '../../../domain/review/reviewPacket';
import type { WorkspaceRecord } from '../../../domain/workspace/workspace';
import type { AdapterResult } from '../../chatgpt/ChatGPTAdapter';
import type { ClaudeRunRequest } from '../../claude/ClaudeRunner';
import { DevelopmentPaneRegistry } from '../../development/DevelopmentPane';
import { AppStateStore } from '../AppStateStore';
import { WorkspaceOrchestrator, type BlockSendStatus, type TaskFinishedNotice } from '../WorkspaceOrchestrator';

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

function fakeChat() {
  const chat = {
    inserted: [] as string[],
    submitted: 0,
    /** ChatGPT is writing a reply right now. */
    generating: false,
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
    getPageState: vi.fn(async (): Promise<AdapterResult<{ generating: boolean }>> => ({ ok: true, value: { generating: chat.generating } })),
    getConversationUrl: (): string | null => chat.currentUrl,
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
  let statuses: BlockSendStatus[];
  let clicks: number;
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
    statuses = [];
    clicks = 0;
    chats = { a: fakeChat(), b: fakeChat() };
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
      blockSendStatus: (_ws, st) => statuses.push(st),
      onChange: () => {},
      handbackWait: { intervalMs: 0, maxWaits: 1 },
      newId: () => `id-${++n}`,
    });
    orch.register('a');
    orch.register('b');
  });

  /** ChatGPT refuses the handback (message box has a draft that never clears). */
  const failDelivery = (ws: string) => chats[ws]!.insertComposerText.mockResolvedValue({ ok: false, code: 'composer_not_empty', detail: '' });
  const allowDelivery = (ws: string) =>
    chats[ws]!.insertComposerText.mockImplementation(async (text: string) => {
      chats[ws]!.inserted.push(text);
      chats[ws]!.insertedAt.push(chats[ws]!.currentUrl);
      return { ok: true, value: { inserted: text.length } };
    });

  /** A click on a block's "Send to Claude" button: `ok` unless that very click reported a failure. */
  async function click(o: WorkspaceOrchestrator, ws: string, text = `Prompt for ${ws.toUpperCase()}`, messageId = `msg-${ws}`): Promise<{ ok: boolean; detail: string }> {
    const id = `req-${++clicks}`;
    await o.sendBlockToClaude(ws, { id, text, messageId });
    const failed = statuses.find((st) => st.id === id && st.state === 'failed');
    return { ok: !failed, detail: failed?.detail ?? '' };
  }

  async function startTask(ws: string, text?: string): Promise<ClaudeRunRequest> {
    const res = await click(orch, ws, text);
    if (!res.ok) throw new Error(res.detail);
    await flush();
    return runs[runs.length - 1]!;
  }

  function complete(req: ClaudeRunRequest, result = 'Done.', isError = false) {
    req.onEvent({ type: 'init', sessionId: `session-${req.workspaceId}-new` });
    req.onEvent({ type: 'result', isError, subtype: isError ? 'error_during_execution' : 'success', result, sessionId: `session-${req.workspaceId}-new` });
    req.onExit({ code: isError ? 1 : 0, signal: null, spawnError: null });
  }

  it('duplicate clicks do not create duplicate tasks', async () => {
    const [r1, r2] = await Promise.all([click(orch, 'a'), click(orch, 'a')]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    expect((await click(orch, 'a')).ok).toBe(false); // still running
    await flush();
    expect(runs).toHaveLength(1);
    expect(store.get().tasks).toHaveLength(1);
  });

  it('task belongs to the selected Workspace: its cwd, its session, its prompt', async () => {
    const req = await startTask('b');
    expect(req.workspaceId).toBe('b');
    expect(req.cwd).toBe('/tmp/project-b');
    expect(req.resumeSessionId).toBe('session-b');
    expect(req.prompt.startsWith('Prompt for B')).toBe(true);
    expect(req.prompt).toContain(`<<<SIDEKICK_START:${req.taskId}:${req.marker!.nonce}>>>`);
    expect(req.prompt).toContain(`<<<SIDEKICK_END:${req.taskId}:${req.marker!.nonce}>>>`);
    expect(req.marker!.taskId).toBe(req.taskId);
    expect(orch.view('a')!.task).toBeNull();
    complete(req);
    await flush();
    expect(store.workspace('b')!.claudeSessionId).toBe('session-b-new');
    expect(store.workspace('a')!.claudeSessionId).toBeNull();
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
    chats.a!.getConversationUrl = () => null;
    const req = await startTask('a');
    complete(req);
    await flush();
    expect(chats.a!.inserted).toHaveLength(0);
    expect(orch.view('a')!.latestReview!.status).toBe('failed');
  });

  it('the user keeps chatting while Claude runs: the handback waits for the reply to finish, then goes through', async () => {
    const req = await startTask('a');
    chats.a!.generating = true;
    complete(req, 'Result A');
    chats.a!.generating = false; // ChatGPT finishes while the handback waits
    await flush();
    expect(chats.a!.submitted).toBe(1);
    expect(orch.view('a')!.task!.status).toBe('review_sent');
  });

  it('if ChatGPT never stops replying the result is kept with a Retry, not lost', async () => {
    const req = await startTask('a');
    chats.a!.generating = true;
    complete(req, 'Result A');
    await flush();
    expect(chats.a!.inserted).toHaveLength(0);
    expect(orch.view('a')!.latestReview).toMatchObject({ status: 'failed', lastError: expect.stringContaining('still responding') });
    chats.a!.generating = false;
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
      const a2 = await startTask('a', 'Second prompt');
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
      const a2 = await startTask('a', 'Second prompt');
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
      expect(req.prompt.startsWith('Prompt for A')).toBe(true);
      expect(req.marker?.taskId).toBe(req.taskId);
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

  it('a failed prompt can be re-run', async () => {
    const req = await startTask('a');
    complete(req, 'boom', true);
    await flush();
    expect((await click(orch, 'a')).ok).toBe(true);
  });

  it('refuses Send to Claude while the terminal Claude is busy with another turn', async () => {
    const deps = (orch as unknown as { deps: ConstructorParameters<typeof WorkspaceOrchestrator>[0] }).deps;
    let busy = true;
    const o = new WorkspaceOrchestrator({ ...deps, claudeBusy: () => busy });
    o.register('a');
    const res = await click(o, 'a');
    expect(res).toMatchObject({ ok: false, detail: expect.stringContaining('still working in the terminal') });
    expect(runs).toHaveLength(0);
    busy = false;
    expect((await click(o, 'a')).ok).toBe(true);
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
    expect((await click(o, 'a')).ok).toBe(true);
    await flush();
    expect(o.view('a')!.task).toMatchObject({ status: 'failed', error: expect.stringContaining('boom') });
    expect(o.activeTaskWorkspaceIds()).toEqual([]);
  });

});
