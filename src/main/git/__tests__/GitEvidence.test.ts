import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitEvidence, SECRET_PATH } from '../GitEvidence';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-git-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

describe('GitEvidence', () => {
  it('captures before/after evidence without secrets', async () => {
    const dir = repo();
    const git = new GitEvidence();
    const before = await git.snapshot(dir, 'before');
    expect(before).toMatchObject({ isRepo: true, branch: 'main' });
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, 'new.txt'), 'hello\n');
    writeFileSync(join(dir, '.env'), 'API_KEY=supersecret\n');
    execFileSync('git', ['add', '.env'], { cwd: dir });
    const after = await git.snapshot(dir, 'after', before.headSha);
    expect(after.changedFiles.join('\n')).toContain('a.txt');
    expect(after.changedFiles.join('\n')).toContain('new.txt (untracked)');
    expect(after.diffStat).toContain('a.txt');
    expect(after.diffExcerpt).toContain('+two');
    expect(after.diffExcerpt).toContain('+hello');
    expect(after.diffExcerpt ?? '').not.toContain('supersecret');
    writeFileSync(join(dir, 'secret.env'), 'X');
    writeFileSync(join(dir, 'aws_credentials.txt'), 'TOKEN=leak');
    const again = await git.snapshot(dir, 'after', before.headSha);
    expect(again.diffExcerpt ?? '').not.toContain('leak');
  });

  it('excludes secret files case-insensitively, tracked and untracked', async () => {
    const dir = repo();
    const git = new GitEvidence();
    const before = await git.snapshot(dir, 'before');
    const secrets: Record<string, string> = {
      '.ENV.Production': 'leak-env',
      '.envrc': 'leak-envrc',
      'Config/ID_ECDSA': 'leak-ecdsa',
      'id_dsa.pub': 'leak-dsa',
      '.npmrc': 'leak-npmrc',
      '.netrc': 'leak-netrc',
      'release.KEYSTORE': 'leak-keystore',
      'upload.jks': 'leak-jks',
      'Server.PEM': 'leak-pem',
    };
    execFileSync('mkdir', ['-p', join(dir, 'Config')]);
    for (const [f, c] of Object.entries(secrets)) writeFileSync(join(dir, f), `${c}\n`);
    // Half of them tracked (staged), the rest untracked.
    execFileSync('git', ['add', '.ENV.Production', '.npmrc', 'Config/ID_ECDSA', 'upload.jks'], { cwd: dir });
    writeFileSync(join(dir, 'ok.txt'), 'visible\n');
    const after = await git.snapshot(dir, 'after', before.headSha);
    expect(after.diffExcerpt).toContain('+visible');
    for (const c of Object.values(secrets)) expect(after.diffExcerpt ?? '').not.toContain(c);
    for (const f of Object.keys(secrets)) expect(SECRET_PATH.test(f)).toBe(true);
    expect(SECRET_PATH.test('src/environment.ts')).toBe(false);
  });

  it('reports non-repositories', async () => {
    const snap = await new GitEvidence().snapshot(mkdtempSync(join(tmpdir(), 'ws-nogit-')), 'before');
    expect(snap.isRepo).toBe(false);
  });

  it('does not modify the repository', async () => {
    const dir = repo();
    const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const s1 = status();
    await new GitEvidence().snapshot(dir, 'after');
    expect(status()).toBe(s1);
  });
});
