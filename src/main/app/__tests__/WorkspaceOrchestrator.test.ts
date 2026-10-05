import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitSnapshot } from '../../../domain/review/reviewPacket';
import type { WorkspaceRecord } from '../../../domain/workspace/workspace';
import type { AdapterResult, ClaudePromptCandidate } from '../../chatgpt/ChatGPTAdapter';
import type { ClaudeRunRequest } from '../../claude/ClaudeRunner';
import { DevelopmentPaneRegistry } from '../../development/DevelopmentPane';
import { AppStateStore } from '../AppStateStore';
import { WorkspaceOrchestrator, type TaskFinishedNotice } from '../WorkspaceOrchestrator';

const flush = () => new Promise((r) => setTimeout(r, 0));

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
    getLatestClaudePromptBlock: vi.fn(async () => block()),
    getLatestUserMessage: vi.fn(async (): Promise<AdapterResult<{ text: string; messageId: string | null }>> => ({ ok: true, value: { text: chat.userMessage, messageId: 'u-1' } })),
    insertComposerText: vi.fn(async (text: string): Promise<AdapterResult<{ inserted: number }>> => {
      chat.inserted.push(text);
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
      newId: () => `id-${++n}`,
    });
    orch.register('a');
    orch.register('b');
  });

  /** A candidate is accepted once the same block is observed on two consecutive polls. */
  function seen(ws: string, res: AdapterResult<ClaudePromptCandidate>) {
    orch.observeCandidate(ws, res);
    orch.observeCandidate(ws, res);
  }

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
    expect(orch.view('a')!.task!.status).toBe('review_pending');
  });

  it('completion builds a review packet, marks review_pending and notifies — but never sends to ChatGPT by itself', async () => {
    foreground = 'b'; // a finishes in the background
    const req = await startTask('a');
    complete(req, 'Implemented X');
    await flush();
    const view = orch.view('a')!;
    expect(view.task!.status).toBe('review_pending');
    expect(view.task!.outcome).toBe('succeeded');
    expect(view.task!.review!.body).toContain('Implemented X');
    expect(view.task!.review!.body).toContain('M src/x.ts');
    expect(view.attention).toBe('completed');
    expect(notices).toEqual([expect.objectContaining({ workspaceId: 'a', background: true, kind: 'success' })]);
    expect(chats.a!.insertComposerText).not.toHaveBeenCalled();
    expect(chats.a!.submitComposer).not.toHaveBeenCalled();
    expect(orch.attentionCount()).toBe(1);
    orch.activate('a');
    expect(orch.view('a')!.attention).toBe('none');
  });

  it('review handback happens only on explicit approval, into the owning Workspace conversation', async () => {
    const req = await startTask('a');
    complete(req);
    await flush();
    const taskId = orch.view('a')!.task!.id;
    expect((await orch.sendReview('b', taskId)).ok).toBe(false);
    expect(chats.b!.insertComposerText).not.toHaveBeenCalled();
    const r = await orch.sendReview('a', taskId);
    expect(r.ok).toBe(true);
    expect(chats.a!.inserted).toHaveLength(1);
    expect(chats.a!.submitted).toBe(1);
    expect(orch.view('a')!.task!.status).toBe('review_sent');
    expect((await orch.sendReview('a', taskId)).ok).toBe(false);
    expect(chats.a!.submitted).toBe(1);
  });

  it('failed handback keeps review_pending, allows retry and never re-runs Claude', async () => {
    const req = await startTask('a');
    complete(req);
    await flush();
    const taskId = orch.view('a')!.task!.id;
    chats.a!.insertComposerText.mockResolvedValueOnce({ ok: false, code: 'composer_not_empty', detail: '' });
    const r1 = await orch.sendReview('a', taskId);
    expect(r1.ok).toBe(false);
    expect(orch.view('a')!.task!.status).toBe('review_pending');
    expect(orch.view('a')!.task!.review).toMatchObject({ status: 'failed', lastError: expect.any(String) });
    expect(runs).toHaveLength(1);
    const r2 = await orch.sendReview('a', taskId);
    expect(r2.ok).toBe(true);
    expect(orch.view('a')!.task!.review).toMatchObject({ status: 'sent', lastError: null });
    expect(runs).toHaveLength(1);
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
      expect(orch.view('a')!.latestReview!.body).toContain('Result A');
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

    it('the previous completed result stays available while a later task runs, and the new one replaces it when it completes', async () => {
      const a1 = await startTask('a');
      complete(a1, 'Result A');
      await flush();
      const firstTask = orch.view('a')!.latestReview!.taskId;
      blocks.a = ok('Second prompt', 'msg-2');
      seen('a', blocks.a);
      const a2 = await startTask('a');
      const during = orch.view('a')!;
      expect(during.task!.status).toBe('running');
      expect(during.latestReview).toMatchObject({ taskId: firstTask, status: 'pending' });
      expect(during.latestReview!.body).toContain('Result A');
      complete(a2, 'Result B');
      await flush();
      expect(orch.view('a')!.latestReview!.body).toContain('Result B');
    });

    it('a cancelled later task does not replace an earlier completed result; it can be handed to ChatGPT meanwhile', async () => {
      const a1 = await startTask('a');
      complete(a1, 'Result A');
      await flush();
      const firstTask = orch.view('a')!.latestReview!.taskId;
      blocks.a = ok('Second prompt', 'msg-2');
      seen('a', blocks.a);
      const a2 = await startTask('a');
      // hand the previous result over while the second task is still running
      expect((await orch.sendReview('a', firstTask)).ok).toBe(true);
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
      expect(orch.view('a')!.latestReview!.taskId).toBe(taskId);
      expect(chats.a!.submitComposer).not.toHaveBeenCalled(); // never automatic
      store.setViewMode('a', 'chatgpt-focus');
      expect((await orch.sendReview('a', taskId)).ok).toBe(true);
      expect(chats.a!.submitted).toBe(1);
      expect(chats.b!.submitted).toBe(0);
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
      expect(orch.view('a')!.latestReview).not.toBeNull();
      expect(orch.view('b')!.latestReview).toBeNull();
      expect(orch.view('b')!.task).toBeNull();
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
      await orch.sendReview('a', orch.view('a')!.task!.id);
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
      const req = await startTask('a');
      complete(req);
      await flush();
      chats.a!.insertComposerText.mockResolvedValueOnce({ ok: false, code: 'composer_not_empty', detail: '' });
      await orch.sendReview('a', orch.view('a')!.task!.id);
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
      orch.observeCandidate('b', { ok: false, code: 'no_prompt_block', detail: '' });
      expect(orch.view('b')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
    });

    it('ChatGPT writing again cancels the countdown', async () => {
      await ready();
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
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

    it('asking to send a prompt that was already there sends it once ChatGPT has replied', async () => {
      chats.a!.userMessage = 'Bir prompt yaz';
      await ready();
      expect(orch.view('a')!.autoSend).toBeNull();
      // The user now says "send it"; ChatGPT answers without writing a new block.
      chats.a!.userMessage = ASK;
      chats.a!.getLatestUserMessage.mockImplementation(async () => ({ ok: true, value: { text: chats.a!.userMessage, messageId: 'u-2' } }));
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      seen('a', blocks.a!);
      await tick(0);
      expect(orch.view('a')!.autoSend).not.toBeNull();
      await tick(3_000);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.prompt).toBe('Prompt for A');
    });

    it('one request starts at most one countdown, even after Cancel', async () => {
      chats.a!.userMessage = 'Bir prompt yaz';
      await ready();
      chats.a!.userMessage = ASK;
      chats.a!.getLatestUserMessage.mockImplementation(async () => ({ ok: true, value: { text: chats.a!.userMessage, messageId: 'u-2' } }));
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      seen('a', blocks.a!);
      await tick(0);
      orch.cancelAutoSendRequest('a');
      // Another reply to some other message, but the latest user message is still the same request.
      orch.observeCandidate('a', { ok: false, code: 'still_generating', detail: '' });
      seen('a', blocks.a!);
      await tick(0);
      expect(orch.view('a')!.autoSend).toBeNull();
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

    it('a request whose ChatGPT message id cannot be resolved never auto-sends (the button stays)', async () => {
      chats.a!.getLatestUserMessage.mockImplementation(async () => ({ ok: true, value: { text: ASK, messageId: null } }));
      await ready();
      expect(orch.view('a')!.autoSend).toBeNull();
      await tick(10_000);
      expect(runs).toHaveLength(0);
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
});
