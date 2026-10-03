import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ session: {}, shell: {}, WebContentsView: class {} }));

const { chromeLikeUserAgent, rateLimited, redactUrl, redactUrlsIn, remoteWebPreferences } = await import('../remoteContent');

describe('remote content hardening', () => {
  it('uses the mandatory secure webPreferences and no preload', () => {
    const p = remoteWebPreferences();
    expect(p).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      partition: 'persist:chatgpt',
    });
    expect(p.preload).toBeUndefined();
  });

  it('strips Electron/app tokens from the user agent only', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Workspace/0.1.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36';
    expect(chromeLikeUserAgent(ua)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36',
    );
  });

  it('strips any app-name token from the user agent', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Avva Mobile Sidekick/0.1.0 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36';
    expect(chromeLikeUserAgent(ua)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36',
    );
  });

  it('redacts query strings (OAuth codes) from logged URLs', () => {
    expect(redactUrl('https://auth.openai.com/callback?code=SECRET&state=x#frag')).toBe('https://auth.openai.com/callback');
  });
});

describe('external opens and log redaction', () => {
  it('opens the OS browser at most once per 2 s', () => {
    let t = 0;
    const opened: string[] = [];
    const open = rateLimited((u: string) => void opened.push(u), 2_000, () => t);
    expect(open('https://a.example/')).toBe(true);
    t = 500;
    expect(open('https://b.example/')).toBe(false);
    t = 2_000;
    expect(open('https://c.example/')).toBe(true);
    expect(opened).toEqual(['https://a.example/', 'https://c.example/']);
  });

  it('redacts query strings of URLs inside error messages', () => {
    expect(redactUrlsIn("ERR_ABORTED (-3) loading 'https://chatgpt.com/c/abc?code=secret#x'")).toBe("ERR_ABORTED (-3) loading 'https://chatgpt.com/c/abc'");
    expect(redactUrlsIn('no url here')).toBe('no url here');
  });
});
