import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdapterResult, ClaudePromptCandidate } from '../../chatgpt/ChatGPTAdapter';
import type { ClaudeRunRequest } from '../../claude/ClaudeRunner';
import { DevelopmentPaneRegistry } from '../../development/DevelopmentPane';
import { AppStateStore } from '../AppStateStore';
import { WorkspaceOrchestrator, type BlockSendStatus } from '../WorkspaceOrchestrator';

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const candidate = (text: string): AdapterResult<ClaudePromptCandidate> => ({ ok: true, value: { text, messageId: 'cand', conversationUrl: 'https://chatgpt.com/c/x', truncated: false, capturedAt: '' } });

describe('block "Send to Claude" button', () => {
  let runs: ClaudeRunRequest[];
  let statuses: BlockSendStatus[];
  let orch: WorkspaceOrchestrator;
  let n: number;

  beforeEach(() => {
    const store = new AppStateStore(join(mkdtempSync(join(tmpdir(), 'ws-block-')), 'state.json'), 0);
    store.addWorkspace({ id: 'a', name: 'A', projectPath: '/tmp/a', createdAt: '', updatedAt: '', lastOpenedAt: null, sidebarColor: '#123456', sidebarOrder: 0, chatConversationUrl: null, claudeSessionId: null, uiState: { splitRatio: 0.6 }, lastTaskId: null });
    runs = [];
    statuses = [];
    n = 0;
    const chat = {
      // A different, newer "latest" block: must never be what a block button sends.
      getLatestClaudePromptBlock: async () => candidate('LATEST BLOCK (wrong)'),
      getLatestUserMessage: async () => ({ ok: true as const, value: { text: 'hi', messageId: 'u' } }),
      getConversationUrl: () => 'https://chatgpt.com/c/x',
      insertComposerText: async () => ({ ok: true as const, value: { inserted: 0 } }),
      submitComposer: async () => ({ ok: true as const, value: { via: 'send-button' } }),
      ensureConversation: async () => ({ ok: true as const, value: { restored: false } }),
    };
    orch = new WorkspaceOrchestrator({
      store,
      panes: new DevelopmentPaneRegistry(),
      runner: { start: (req) => (runs.push(req), { cancel: () => {} }) },
      git: { snapshot: async () => ({ phase: 'before', capturedAt: '', isRepo: false, branch: null, headSha: null, statusShort: '', changedFiles: [], diffStat: null, diffExcerpt: null, truncated: false, error: null }) },
      chatFor: () => chat,
      isForeground: () => true,
      notifyTaskFinished: () => {},
      onChange: () => {},
      blockSendStatus: (_ws, s) => statuses.push(s),
      handbackWait: { intervalMs: 0, maxWaits: 1 },
      newId: () => `id-${++n}`,
    });
    orch.register('a');
    // The preferences suffix is on by default: a block send must ignore it.
  });

  it('sends exactly the clicked block text (no capture, no candidate, no suffix) and reports started only after Claude confirms', async () => {
    orch.observeCandidate('a', candidate('STALE CANDIDATE'));
    orch.observeCandidate('a', candidate('STALE CANDIDATE'));
    await orch.sendBlockToClaude('a', { id: 'r1', text: 'Block two text\n- keep', messageId: 'm-2' });
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toBe('Block two text\n- keep');
    expect(statuses).toEqual([]); // not started yet: Claude has not confirmed
    runs[0]!.onEvent({ type: 'submitted' });
    expect(statuses).toEqual([{ id: 'r1', state: 'started', detail: expect.any(String) }]);
    expect(orch.view('a')!.task).toMatchObject({ prompt: 'Block two text\n- keep' });
  });

  it('a run that ends without Claude confirming the prompt fails the button with the reason', async () => {
    await orch.sendBlockToClaude('a', { id: 'r2', text: 'x', messageId: null });
    await flush();
    runs[0]!.onExit({ code: null, signal: null, spawnError: 'Claude did not report receiving the prompt in the terminal. Check the terminal, then send again.' });
    expect(statuses).toEqual([{ id: 'r2', state: 'failed', detail: expect.stringContaining('did not report receiving') }]);
  });

  it('a refusal (task already running) is reported as failed on that button', async () => {
    await orch.sendBlockToClaude('a', { id: 'r3', text: 'first', messageId: null });
    await orch.sendBlockToClaude('a', { id: 'r4', text: 'second', messageId: null });
    await flush();
    expect(runs).toHaveLength(1);
    expect(statuses).toEqual([{ id: 'r4', state: 'failed', detail: 'Claude is already working.' }]);
  });
});
