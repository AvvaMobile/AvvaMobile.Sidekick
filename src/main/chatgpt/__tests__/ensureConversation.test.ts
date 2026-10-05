import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ChatGPTAdapter } from '../ChatGPTAdapter';

/** Minimal WebContents: a URL that loadURL changes, and a composer that is (or is not) there. */
function fakeWc(url: string, opts: { composer?: boolean; redirectTo?: string; loadError?: string } = {}) {
  const wc = {
    url,
    isDestroyed: () => false,
    getURL: () => wc.url,
    loadURL: vi.fn(async (next: string) => {
      if (opts.loadError) throw new Error(opts.loadError);
      wc.url = opts.redirectTo ?? next;
    }),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ ok: opts.composer ?? true, text: '' })),
  };
  return wc;
}
const adapter = (wc: ReturnType<typeof fakeWc>) => new ChatGPTAdapter(wc as unknown as WebContents);

describe('ChatGPTAdapter.ensureConversation', () => {
  it('stays put when the view already shows the source conversation', async () => {
    const wc = fakeWc('https://chatgpt.com/c/abc?x=1');
    expect(await adapter(wc).ensureConversation('https://chatgpt.com/c/abc')).toEqual({ ok: true, value: { restored: false } });
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it('navigates back to the source conversation when the user moved on, and waits for the composer', async () => {
    const wc = fakeWc('https://chatgpt.com/c/other');
    expect(await adapter(wc).ensureConversation('https://chatgpt.com/c/abc')).toEqual({ ok: true, value: { restored: true } });
    expect(wc.loadURL).toHaveBeenCalledWith('https://chatgpt.com/c/abc');
  });

  it('refuses when the source is unknown or not a conversation URL (never guesses)', async () => {
    const wc = fakeWc('https://chatgpt.com/c/other');
    expect(await adapter(wc).ensureConversation(null)).toMatchObject({ ok: false, code: 'conversation_unavailable' });
    expect(await adapter(wc).ensureConversation('https://evil.example/c/abc')).toMatchObject({ ok: false, code: 'conversation_unavailable' });
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it('fails when ChatGPT lands somewhere else or the load fails', async () => {
    expect(await adapter(fakeWc('https://chatgpt.com/c/other', { redirectTo: 'https://chatgpt.com/auth/login' })).ensureConversation('https://chatgpt.com/c/abc')).toMatchObject({
      ok: false,
      code: 'conversation_unavailable',
    });
    expect(await adapter(fakeWc('https://chatgpt.com/c/other', { loadError: 'ERR_FAILED' })).ensureConversation('https://chatgpt.com/c/abc')).toMatchObject({
      ok: false,
      code: 'conversation_unavailable',
    });
  });
});
