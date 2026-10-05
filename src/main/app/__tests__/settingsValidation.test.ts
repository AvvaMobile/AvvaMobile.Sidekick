import { describe, expect, it } from 'vitest';
import { validateProjectSettingsPatch } from '../settingsValidation';

const dirs = new Set(['/Users/x/proj', '/Users/x/other']);
const isDir = (p: string) => dirs.has(p);
const v = (raw: unknown) => validateProjectSettingsPatch(raw, isDir);

describe('validateProjectSettingsPatch', () => {
  it('rejects non-objects, empty patches and unknown fields', () => {
    for (const raw of [null, undefined, 'x', 3, [], {}]) expect(v(raw).ok).toBe(false);
    const r = v({ name: 'A', sidebarOrder: 3 });
    expect(r).toEqual({ ok: false, detail: 'Unknown setting: sidebarOrder' });
    expect(v({ claudeSessionId: 'abc' }).ok).toBe(false);
  });

  it('normalizes and validates the name', () => {
    expect(v({ name: '  My   Project ' })).toEqual({ ok: true, patch: { name: 'My Project' } });
    expect(v({ name: '   ' }).ok).toBe(false);
    expect(v({ name: 'x'.repeat(61) }).ok).toBe(false);
    expect(v({ name: 5 }).ok).toBe(false);
  });

  it('accepts only existing absolute folders', () => {
    expect(v({ projectPath: '/Users/x/proj' })).toEqual({ ok: true, patch: { projectPath: '/Users/x/proj' } });
    expect(v({ projectPath: '/Users/x/missing' }).ok).toBe(false);
    expect(v({ projectPath: 'relative/proj' }).ok).toBe(false);
    expect(v({ projectPath: null }).ok).toBe(false);
  });

  it('accepts #rrggbb colors (lower-cased) only', () => {
    expect(v({ color: '#AABBCC' })).toEqual({ ok: true, patch: { color: '#aabbcc' } });
    for (const color of ['red', '#abc', '#gggggg', 'url(x)', null]) expect(v({ color }).ok).toBe(false);
  });

  it('accepts a known model or null (app default)', () => {
    expect(v({ model: 'sonnet' })).toEqual({ ok: true, patch: { model: 'sonnet' } });
    expect(v({ model: null })).toEqual({ ok: true, patch: { model: null } });
    expect(v({ model: 'gpt-4' }).ok).toBe(false);
    expect(v({ model: '' }).ok).toBe(false);
  });

  it('accepts a ChatGPT conversation link (without fragment) or null', () => {
    expect(v({ chatConversationUrl: 'https://chatgpt.com/c/abc-123#x' })).toEqual({ ok: true, patch: { chatConversationUrl: 'https://chatgpt.com/c/abc-123' } });
    expect(v({ chatConversationUrl: 'https://chatgpt.com/c/abc-123?model=x&token=y' })).toEqual({ ok: true, patch: { chatConversationUrl: 'https://chatgpt.com/c/abc-123' } });
    expect(v({ chatConversationUrl: null })).toEqual({ ok: true, patch: { chatConversationUrl: null } });
    for (const u of ['https://chatgpt.com/', 'https://evil.com/c/abc', 'http://chatgpt.com/c/abc', 'javascript:alert(1)', 42])
      expect(v({ chatConversationUrl: u }).ok).toBe(false);
  });

  it('icon can only be removed (null)', () => {
    expect(v({ icon: null })).toEqual({ ok: true, patch: { icon: null } });
    expect(v({ icon: '/tmp/x.png' }).ok).toBe(false);
  });

  it('validates every field of a combined patch', () => {
    expect(v({ name: 'B', color: '#112233', model: 'opus' })).toEqual({ ok: true, patch: { name: 'B', color: '#112233', model: 'opus' } });
    expect(v({ name: 'B', color: 'nope' }).ok).toBe(false);
  });
});
