import { describe, expect, it, vi } from 'vitest';
import { parseGithubRepository } from '../../../shared/github';
import { validateProjectSettingsPatch } from '../../app/settingsValidation';
import { checkGithubAccess, permissionLevel, setGithubRepository, verifyWorkspaceGithub, type GithubCheckDeps, type GithubStore } from '../GithubAccessChecker';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
const deps = (over: Partial<GithubCheckDeps> = {}): GithubCheckDeps => ({ getToken: async () => 'secret-token', fetch: reply(200) as never, now: () => NOW, ...over });

describe('repository value', () => {
  it('normalizes owner/repo and github.com URLs', () => {
    expect(parseGithubRepository(' AvvaMobile/AvvaMobile.Sidekick ')).toBe('AvvaMobile/AvvaMobile.Sidekick');
    expect(parseGithubRepository('https://github.com/a/b.git')).toBe('a/b');
    expect(parseGithubRepository('git@github.com:a/b.git')).toBe('a/b');
    for (const bad of ['', 'a', 'a/b/c', 'a/..', '-a/b', 'a b/c', 'a/b; rm -rf /', 42]) expect(parseGithubRepository(bad)).toBeNull();
  });

  it('can be saved before authentication (validation needs no token) and null clears it', () => {
    expect(validateProjectSettingsPatch({ githubRepository: 'https://github.com/a/b' }, () => true)).toEqual({ ok: true, patch: { githubRepository: 'a/b' } });
    expect(validateProjectSettingsPatch({ githubRepository: null }, () => true)).toEqual({ ok: true, patch: { githubRepository: null } });
    expect(validateProjectSettingsPatch({ githubRepository: 'nope' }, () => true).ok).toBe(false);
  });
});

describe('checkGithubAccess', () => {
  it('returns auth-required without a token and does not call GitHub', async () => {
    const fetch = reply(200);
    const r = await checkGithubAccess('a/b', deps({ getToken: async () => null, fetch: fetch as never }));
    expect(r).toEqual({ status: 'auth-required', checkedAt: NOW.toISOString() });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns accessible with the permission level', async () => {
    const r = await checkGithubAccess('a/b', deps({ fetch: reply(200, { permissions: { admin: false, maintain: false, push: true, triage: true, pull: true } }) as never }));
    expect(r).toEqual({ status: 'accessible', permission: 'write', checkedAt: NOW.toISOString() });
  });

  it('is accessible without a permission level when GitHub does not report one', async () => {
    expect(await checkGithubAccess('a/b', deps())).toEqual({ status: 'accessible', checkedAt: NOW.toISOString() });
  });

  it('maps permissions to the highest level', () => {
    expect(permissionLevel({ admin: true, push: true, pull: true })).toBe('admin');
    expect(permissionLevel({ maintain: true, push: true, pull: true })).toBe('maintain');
    expect(permissionLevel({ triage: true, pull: true })).toBe('triage');
    expect(permissionLevel({ pull: true })).toBe('read');
    expect(permissionLevel({})).toBeUndefined();
  });

  it('maps 404 / 403 / 401 / failures safely, without leaking the token', async () => {
    const status = async (s: number, h?: Record<string, string>) => checkGithubAccess('a/b', deps({ fetch: reply(s, { message: 'secret-token' }, h) as never }));
    expect((await status(404)).status).toBe('not-found');
    expect((await status(403)).status).toBe('no-access');
    expect((await status(403, { 'x-ratelimit-remaining': '0' })).status).toBe('error');
    expect((await status(401)).status).toBe('auth-required');
    expect((await status(500)).status).toBe('error');
    const boom = await checkGithubAccess('a/b', deps({ fetch: (async () => { throw new Error('secret-token boom'); }) as never }));
    expect(JSON.stringify(boom)).not.toContain('secret-token');
    expect(boom.status).toBe('error');
  });

  it('sends the token only as a bearer header to the repo API', async () => {
    const fetch = reply(200);
    await checkGithubAccess('a/b.c', deps({ fetch: fetch as never }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/a/b.c');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });
});

function fakeStore(): GithubStore & { ws: Map<string, Record<string, unknown>> } {
  const ws = new Map<string, Record<string, unknown>>([
    ['w1', { githubRepository: 'a/one' }],
    ['w2', { githubRepository: 'a/two' }],
  ]);
  return {
    ws,
    workspace: (id) => ws.get(id) as never,
    updateWorkspace: (id, patch) => void Object.assign(ws.get(id)!, patch),
  };
}

describe('verifyWorkspaceGithub', () => {
  it('stores the result on the Workspace that was checked only', async () => {
    const s = fakeStore();
    await verifyWorkspaceGithub(s, 'w1', deps({ fetch: reply(200, { permissions: { pull: true } }) as never }));
    expect(s.ws.get('w1')!.githubAccess).toMatchObject({ status: 'accessible', permission: 'read' });
    expect(s.ws.get('w2')!.githubAccess).toBeUndefined();
  });

  it('drops a stale result when the repository changed during the check', async () => {
    const s = fakeStore();
    const r = await verifyWorkspaceGithub(s, 'w1', deps({ fetch: (async () => { Object.assign(s.ws.get('w1')!, { githubRepository: 'a/new', githubAccess: null }); return new Response('{}', { status: 200 }); }) as never }));
    expect(r).toBeNull();
    expect(s.ws.get('w1')!.githubAccess).toBeNull();
  });

  it('drops the result when the repository was cleared during the check', async () => {
    const s = fakeStore();
    await verifyWorkspaceGithub(s, 'w1', deps({ fetch: (async () => { Object.assign(s.ws.get('w1')!, { githubRepository: null, githubAccess: null }); return new Response('{}', { status: 200 }); }) as never }));
    expect(s.ws.get('w1')!.githubAccess).toBeNull();
  });

  it('does nothing without a repository', async () => {
    const s = fakeStore();
    s.ws.set('w3', {});
    expect(await verifyWorkspaceGithub(s, 'w3', deps())).toBeNull();
  });

  it('an old verification does not prevent an explicit re-check', async () => {
    const s = fakeStore();
    await verifyWorkspaceGithub(s, 'w1', deps({ fetch: reply(200) as never }));
    expect(s.ws.get('w1')!.githubAccess).toMatchObject({ status: 'accessible' });
    await verifyWorkspaceGithub(s, 'w1', deps({ fetch: reply(404) as never }));
    expect(s.ws.get('w1')!.githubAccess).toMatchObject({ status: 'not-found' });
  });
});

describe('setGithubRepository', () => {
  it('changing the repository clears stale verification', () => {
    const s = fakeStore();
    s.ws.get('w1')!.githubAccess = { status: 'accessible' };
    setGithubRepository(s, 'w1', 'a/other');
    expect(s.ws.get('w1')).toMatchObject({ githubRepository: 'a/other', githubAccess: null });
  });
  it('clearing the repository clears verification', () => {
    const s = fakeStore();
    s.ws.get('w1')!.githubAccess = { status: 'accessible' };
    setGithubRepository(s, 'w1', null);
    expect(s.ws.get('w1')).toMatchObject({ githubRepository: null, githubAccess: null });
  });
  it('saving the same value keeps the last known result', () => {
    const s = fakeStore();
    s.ws.get('w1')!.githubAccess = { status: 'accessible' };
    setGithubRepository(s, 'w1', 'a/one');
    expect(s.ws.get('w1')!.githubAccess).toEqual({ status: 'accessible' });
  });
});
