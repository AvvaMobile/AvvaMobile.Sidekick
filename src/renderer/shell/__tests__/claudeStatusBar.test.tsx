// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceView } from '../../../shared/state';
import { ClaudeStatusBar } from '../components/ClaudeStatusBar';
import { claudeStatus } from '../viewModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string, over: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id, name: `P ${id}`, projectPath: `/Users/x/${id}`, color: '#123', initial: 'P', iconUrl: null, claudeSessionId: null, model: 'opus', effort: null,
    splitRatio: 0.6, viewMode: 'chatgpt-focus', attention: 'none', chatgpt: { loggedIn: true }, task: null,
    latestReview: null, terminal: { running: true, error: null }, ...over,
  };
}
const task = (status: string, over: Record<string, unknown> = {}) => ({ id: 't1', status, outcome: null, prompt: 'p', createdAt: '', error: null, review: null, ...over }) as unknown as WorkspaceView['task'];
const review = { taskId: 't1', status: 'pending' as const, lastError: null, body: 'RESULT' };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const props = () => ({ style: {}, onRetry: vi.fn(), onStop: vi.fn(), onOpenClaude: vi.fn() });
const render = (active: WorkspaceView, p = props()) => {
  act(() => root.render(<ClaudeStatusBar active={active} {...p} />));
  return p;
};
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
const labels = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
const status = () => host.querySelector('.status-label')?.textContent;

describe('claudeStatus', () => {
  it('derives each Workspace’s state from its own task', () => {
    expect(claudeStatus(ws('a'))).toBe('idle');
    expect(claudeStatus(ws('a', { task: task('running') }))).toBe('running');
    expect(claudeStatus(ws('a', { task: task('queued') }))).toBe('running');
    expect(claudeStatus(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: review }))).toBe('sending');
    expect(claudeStatus(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: { ...review, status: 'sending' } }))).toBe('sending');
    expect(claudeStatus(ws('a', { task: task('review_sent', { outcome: 'succeeded' }) }))).toBe('delivered');
    expect(claudeStatus(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: { ...review, status: 'failed', lastError: 'x' } }))).toBe('delivery-failed');
    expect(claudeStatus(ws('a', { task: task('review_pending', { outcome: 'failed' }), latestReview: review }))).toBe('failed');
    expect(claudeStatus(ws('a', { task: task('running', { id: 't2' }), latestReview: review }))).toBe('running');
  });
});

describe('ChatGPT Focus status bar', () => {
  it('Idle: only Open Claude, which switches to Claude Focus; no send button in the bar', () => {
    const p = render(ws('a'));
    expect(status()).toBe('Claude: Idle');
    expect(labels()).toEqual(['Open Claude']);
    act(() => button('Open Claude')!.click());
    expect(p.onOpenClaude).toHaveBeenCalledTimes(1);
  });

  it('Running shows Stop; ChatGPT stays usable (no blocking UI)', () => {
    const p = render(ws('a', { task: task('running') }));
    expect(status()).toBe('Claude: Running…');
    expect(labels()).toEqual(['Stop', 'Open Claude']);
    act(() => button('Stop')!.click());
    expect(p.onStop).toHaveBeenCalled();
  });

  it('a completed task shows its automatic delivery, with no Send to ChatGPT or Retry button', () => {
    render(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: review }));
    expect(status()).toBe('Claude: Completed — sending result to ChatGPT…');
    expect(labels()).not.toContain('Send to ChatGPT');
    expect(labels()).not.toContain('Retry');
    act(() => root.render(<ClaudeStatusBar active={ws('a', { task: task('review_sent', { outcome: 'succeeded' }) })} {...props()} />));
    expect(status()).toBe('Claude: Result delivered');
    expect(labels()).not.toContain('Send to ChatGPT');
  });

  it('only a failed delivery offers Retry, which retries delivery and nothing else', () => {
    const p = render(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: { ...review, status: 'failed', lastError: 'no conversation' } }));
    expect(status()).toBe('Claude: Result delivery failed');
    expect(labels()).toEqual(['Retry', 'Open Claude']);
    act(() => button('Retry')!.click());
    expect(p.onRetry).toHaveBeenCalledTimes(1);
  });

  it('a failed Claude task shows Failed without a send-back button', () => {
    render(ws('a', { task: task('review_pending', { outcome: 'failed' }), latestReview: review }));
    expect(status()).toBe('Claude: Failed');
    expect(labels()).not.toContain('Send to ChatGPT');
  });
});
