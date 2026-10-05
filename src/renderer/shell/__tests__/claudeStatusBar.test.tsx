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
    splitRatio: 0.6, viewMode: 'chatgpt-focus', attention: 'none', chatgpt: { generating: false, loggedIn: true }, candidate: null, sending: false, task: null,
    latestReview: null, terminal: { running: true, error: null }, autoSend: null,
    autoSendNotice: null, ...over,
  };
}
const task = (status: string, over: Record<string, unknown> = {}) => ({ id: 't1', status, outcome: null, prompt: 'p', createdAt: '', error: null, review: null, ...over }) as unknown as WorkspaceView['task'];
const review = { taskId: 't1', status: 'pending' as const, lastError: null, body: 'RESULT' };
const candidate = { text: 'x', messageId: 'm', alreadySent: false };

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
const props = () => ({ busy: false, style: {}, onSend: vi.fn(), onSendReview: vi.fn(), onStop: vi.fn(), onCancelAutoSend: vi.fn(), onOpenClaude: vi.fn() });
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
    expect(claudeStatus(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: review }))).toBe('result-ready');
    expect(claudeStatus(ws('a', { task: task('review_pending', { outcome: 'failed' }), latestReview: review }))).toBe('failed');
    // A later task running does not hide the earlier result's owner state: Running wins while it runs.
    expect(claudeStatus(ws('a', { task: task('running', { id: 't2' }), latestReview: review }))).toBe('running');
  });
});

describe('ChatGPT Focus status bar', () => {
  it('Idle: Send to Claude is disabled without a prompt; Open Claude switches to Claude Focus', () => {
    const p = render(ws('a'));
    expect(status()).toBe('Claude: Idle');
    expect(labels()).toEqual(['Send to Claude', 'Open Claude']);
    expect(button('Send to Claude')!.disabled).toBe(true);
    act(() => button('Open Claude')!.click());
    expect(p.onOpenClaude).toHaveBeenCalledTimes(1);
  });

  it('Send to Claude works from the bar while the terminal is hidden (same handler as Split)', () => {
    const p = render(ws('a', { candidate }));
    expect(button('Send to Claude')!.disabled).toBe(false);
    act(() => button('Send to Claude')!.click());
    expect(p.onSend).toHaveBeenCalledTimes(1);
  });

  it('Running shows Stop and no second Send; ChatGPT stays usable (no blocking UI)', () => {
    const p = render(ws('a', { task: task('running'), candidate }));
    expect(status()).toBe('Claude: Running…');
    expect(labels()).toEqual(['Stop', 'Open Claude']);
    act(() => button('Stop')!.click());
    expect(p.onStop).toHaveBeenCalled();
  });

  it('Result ready offers Send to ChatGPT (never automatic)', () => {
    const p = render(ws('a', { task: task('review_pending', { outcome: 'succeeded' }), latestReview: review }));
    expect(status()).toBe('Claude: Result ready');
    expect(p.onSendReview).not.toHaveBeenCalled();
    act(() => button('Send to ChatGPT')!.click());
    expect(p.onSendReview).toHaveBeenCalledTimes(1);
  });

  it('a result that is being sent cannot be sent twice', () => {
    render(ws('a', { task: task('review_pending'), latestReview: { ...review, status: 'sending' } }));
    expect(button('Send to ChatGPT')!.disabled).toBe(true);
  });

  it('Failed still offers the result for review', () => {
    render(ws('a', { task: task('review_pending', { outcome: 'failed' }), latestReview: review }));
    expect(status()).toBe('Claude: Failed — result ready');
    expect(labels()).toContain('Send to ChatGPT');
  });
});
