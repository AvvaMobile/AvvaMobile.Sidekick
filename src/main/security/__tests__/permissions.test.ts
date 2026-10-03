import { describe, expect, it } from 'vitest';
import { decidePermissionCheck, decidePermissionRequest } from '../permissions';

const mic = (over: Partial<Parameters<typeof decidePermissionRequest>[0]> = {}) =>
  decidePermissionRequest({ permission: 'media', requestingUrl: 'https://chatgpt.com/', topLevelUrl: 'https://chatgpt.com/c/1', mediaTypes: ['audio'], isMainFrame: true, ...over });

describe('permission request policy', () => {
  it('grants audio-only media to ChatGPT main frame', () => {
    expect(mic().allow).toBe(true);
  });

  it('denies camera, mixed and unspecified media', () => {
    expect(mic({ mediaTypes: ['video'] }).allow).toBe(false);
    expect(mic({ mediaTypes: ['audio', 'video'] }).allow).toBe(false);
    expect(mic({ mediaTypes: [] }).allow).toBe(false);
    expect(mic({ mediaTypes: undefined }).allow).toBe(false);
  });

  it('denies microphone for other origins, subframes and auth pages', () => {
    expect(mic({ requestingUrl: 'https://accounts.google.com/' }).allow).toBe(false);
    expect(mic({ requestingUrl: 'https://evil.com/' }).allow).toBe(false);
    expect(mic({ topLevelUrl: 'https://auth.openai.com/log-in' }).allow).toBe(false);
    expect(mic({ isMainFrame: false }).allow).toBe(false);
    expect(mic({ requestingUrl: 'http://chatgpt.com/' }).allow).toBe(false);
  });

  it('denies everything that is not allowlisted', () => {
    for (const p of ['geolocation', 'notifications', 'midi', 'pointerLock', 'fullscreen', 'openExternal', 'display-capture', 'clipboard-read', 'unknown']) {
      expect(decidePermissionRequest({ permission: p, requestingUrl: 'https://chatgpt.com/' }).allow).toBe(false);
    }
  });

  it('allows sanitized clipboard writes only for ChatGPT', () => {
    expect(decidePermissionRequest({ permission: 'clipboard-sanitized-write', requestingUrl: 'https://chatgpt.com/' }).allow).toBe(true);
    expect(decidePermissionRequest({ permission: 'clipboard-sanitized-write', requestingUrl: 'https://evil.com/' }).allow).toBe(false);
  });
});

describe('permission check policy', () => {
  it('reports audio as available only to ChatGPT', () => {
    expect(decidePermissionCheck({ permission: 'media', requestingOrigin: 'https://chatgpt.com', mediaType: 'audio' })).toBe(true);
    expect(decidePermissionCheck({ permission: 'media', requestingOrigin: 'https://chatgpt.com', mediaType: 'video' })).toBe(false);
    expect(decidePermissionCheck({ permission: 'media', requestingOrigin: 'https://chatgpt.com', mediaType: 'unknown' })).toBe(false);
    expect(decidePermissionCheck({ permission: 'media', requestingOrigin: 'https://chatgpt.com' })).toBe(false);
    expect(decidePermissionCheck({ permission: 'media', requestingOrigin: 'https://evil.com', mediaType: 'audio' })).toBe(false);
    expect(decidePermissionCheck({ permission: 'geolocation', requestingOrigin: 'https://chatgpt.com' })).toBe(false);
  });
});
