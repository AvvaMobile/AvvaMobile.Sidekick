import { describe, expect, it } from 'vitest';
import { relayBounds, RELAY_WIDTH } from '../../../shared/shellLayout';
import type { WorkspaceView } from '../../../shared/state';
import { relayState } from '../viewModel';

const ws = (over: Partial<WorkspaceView> = {}): WorkspaceView =>
  ({
    id: 'a',
    candidate: null,
    sending: false,
    task: null,
    chatgpt: { loggedIn: true, generating: false },
    ...over,
  }) as unknown as WorkspaceView;

const review = (status: 'pending' | 'sending') =>
  ({ id: 't1', status: 'review_pending', outcome: 'succeeded', review: { status, lastError: null, body: 'b' } }) as unknown as WorkspaceView['task'];

describe('relay buttons', () => {
  it('are both disabled without a prompt or a pending review', () => {
    const s = relayState(ws(), false);
    expect(s.claude.enabled).toBe(false);
    expect(s.chatgpt.enabled).toBe(false);
    expect(s.claude.title).toContain('Send to Claude');
    expect(s.chatgpt.title).toContain('Send to ChatGPT');
  });

  it('Send to Claude is enabled for a fresh prompt unless the shell is busy', () => {
    const ready = ws({ candidate: { text: 'do it', messageId: 'm', alreadySent: false } });
    expect(relayState(ready, false).claude).toEqual({ enabled: true, title: 'Send to Claude' });
    expect(relayState(ready, true).claude.enabled).toBe(false);
    expect(relayState(ws({ candidate: { text: 'do it', messageId: 'm', alreadySent: false }, sending: true }), false).claude.enabled).toBe(false);
  });

  it('Send to ChatGPT is enabled only while a review is pending', () => {
    expect(relayState(ws({ task: review('pending') }), false).chatgpt).toEqual({ enabled: true, title: 'Send to ChatGPT' });
    expect(relayState(ws({ task: review('sending') }), false).chatgpt.enabled).toBe(false);
  });

  it('the overlay is centred on the splitter', () => {
    const b = relayBounds({ x: 600, y: 44, width: 6, height: 800 });
    expect(b.x + b.width / 2).toBe(603);
    expect(b.width).toBe(RELAY_WIDTH);
    expect(b.y + b.height / 2).toBe(44 + 400);
  });
});
