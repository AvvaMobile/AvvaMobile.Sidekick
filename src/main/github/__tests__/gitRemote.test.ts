import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectGithubRemote, prefillGithubRepository } from '../gitRemote';

type W = { githubRepository?: string | null; githubAccess?: unknown; projectPath: string };
const store = (w: W) => ({ w, workspace: () => w as never, updateWorkspace: (_id: string, p: object) => void Object.assign(w, p) });

describe('detectGithubRemote', () => {
  const repoWith = (url: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-remote-'));
    execFileSync('git', ['init', '-q', dir]);
    if (url) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
    return dir;
  };
  it('reads https and ssh origins', async () => {
    expect(await detectGithubRemote(repoWith('https://github.com/AvvaMobile/Foo.git'))).toBe('AvvaMobile/Foo');
    expect(await detectGithubRemote(repoWith('git@github.com:AvvaMobile/Foo.git'))).toBe('AvvaMobile/Foo');
  });
  it('returns null for other hosts, no origin, non-repos and missing dirs', async () => {
    expect(await detectGithubRemote(repoWith('https://gitlab.com/a/b.git'))).toBeNull();
    expect(await detectGithubRemote(repoWith(null))).toBeNull();
    const plain = mkdtempSync(join(tmpdir(), 'gh-plain-'));
    mkdirSync(join(plain, 'x'));
    expect(await detectGithubRemote(plain)).toBeNull();
    expect(await detectGithubRemote(join(plain, 'missing'))).toBeNull();
  });
});

describe('prefillGithubRepository', () => {
  const found = async () => 'AvvaMobile/Foo';
  it('prefills when never set, without verification state', async () => {
    const s = store({ projectPath: '/x' });
    expect(await prefillGithubRepository(s, 'w', found)).toBe(true);
    expect(s.w).toMatchObject({ githubRepository: 'AvvaMobile/Foo' });
    expect(s.w.githubAccess).toBeUndefined();
  });
  it('never overwrites a saved value or a user-cleared one', async () => {
    const saved = store({ projectPath: '/x', githubRepository: 'a/b' });
    expect(await prefillGithubRepository(saved, 'w', found)).toBe(false);
    expect(saved.w.githubRepository).toBe('a/b');
    const cleared = store({ projectPath: '/x', githubRepository: null });
    expect(await prefillGithubRepository(cleared, 'w', found)).toBe(false);
    expect(cleared.w.githubRepository).toBeNull();
  });
  it('does nothing when nothing is detected', async () => {
    const s = store({ projectPath: '/x' });
    expect(await prefillGithubRepository(s, 'w', async () => null)).toBe(false);
    expect(s.w.githubRepository).toBeUndefined();
  });
});
