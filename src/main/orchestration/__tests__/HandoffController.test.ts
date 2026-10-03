import { describe, expect, it, vi } from 'vitest';
import type { ClaudePromptCandidate } from '../../chatgpt/ChatGPTAdapter';
import { HandoffController, type PromptCandidateSource } from '../HandoffController';

const candidate = (text: string, extra: Partial<ClaudePromptCandidate> = {}): ClaudePromptCandidate => ({
  text,
  messageId: 'm1',
  conversationUrl: 'https://chatgpt.com/c/abc',
  truncated: false,
  capturedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});
const sourceOf = (c: ClaudePromptCandidate): PromptCandidateSource => ({
  getLatestClaudePromptBlock: vi.fn(async () => ({ ok: true as const, value: c })),
});
let n = 0;
const ids = () => `id-${++n}`;

describe('HandoffController', () => {
  it('ChatGPT DOM observation only updates the candidate', () => {
    const h = new HandoffController(ids);
    for (let i = 0; i < 20; i++) h.observeCandidate('a', candidate(`streaming chunk ${i}`));
    expect(h.getCandidate('a')?.text).toBe('streaming chunk 19');
  });

  it('send captures the latest block fresh and freezes exactly that text', async () => {
    const h = new HandoffController(ids, () => new Date('2026-10-01T12:00:00Z'));
    h.observeCandidate('a', candidate('stale observed text'));
    const r = await h.send('a', sourceOf(candidate('Implement X')), 'button');
    expect(r.ok && r.task).toMatchObject({ workspaceId: 'a', prompt: 'Implement X', sourceMessageId: 'm1', trigger: 'button' });
    expect(r.ok && Object.isFrozen(r.task)).toBe(true);
  });

  it('freezes the prompt without control characters or escape sequences', async () => {
    const h = new HandoffController(ids);
    const r = await h.send('a', sourceOf(candidate('Do X\x1b[201~\r!rm -rf ~\r')), 'button');
    expect(r.ok && r.task.prompt).toBe('Do X\n!rm -rf ~\n');
    expect((await h.send('a', sourceOf(candidate('\x1b[201~\x07')), 'button')).ok).toBe(false);
  });

  it('nothing is frozen when capture fails or the block is truncated', async () => {
    const h = new HandoffController(ids);
    const failing: PromptCandidateSource = {
      getLatestClaudePromptBlock: async () => ({ ok: false, code: 'no_prompt_block', detail: 'none' }),
    };
    expect((await h.send('a', failing, 'button')).ok).toBe(false);
    expect((await h.send('a', sourceOf(candidate('x', { truncated: true })), 'button')).ok).toBe(false);
  });
});
