import { execFile } from 'node:child_process';
import type { GitSnapshot } from '../../domain/review/reviewPacket';

/**
 * Read-only Git evidence (docs/ARCHITECTURE.md §12). Never modifies the repository:
 * `--no-optional-locks` keeps `status` from refreshing the index.
 */
export interface GitEvidencePort {
  snapshot(cwd: string, phase: 'before' | 'after', base?: string | null): Promise<GitSnapshot>;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DIFF_EXCERPT_MAX = 8_000;
/** Files (basename globs, matched case-insensitively) whose content must never leave the machine in a review packet. */
const SECRET_GLOBS = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'id_dsa*',
  '.npmrc',
  '.netrc',
  '*secret*',
  '*credential*',
  '*.lock',
  'package-lock.json',
];
const SECRET_PATHSPECS = SECRET_GLOBS.map((g) => `:(exclude,icase,glob)**/${g}`);

/** Same exclusions for untracked files, whose content is read via `git diff --no-index`. */
export const SECRET_PATH = new RegExp(
  `(^|/)(${SECRET_GLOBS.map((g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})$`,
  'i',
);
const UNTRACKED_CONTENT_FILES = 10;

/** `okCodes`: `git diff --no-index` exits 1 when the files differ. */
function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024, okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, maxBuffer, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } },
      (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0;
        if (okCodes.includes(code)) resolve(stdout);
        else reject(err);
      },
    );
  });
}

export class GitEvidence implements GitEvidencePort {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async snapshot(cwd: string, phase: 'before' | 'after', base: string | null = null): Promise<GitSnapshot> {
    const snap: GitSnapshot = {
      phase,
      capturedAt: this.now().toISOString(),
      isRepo: false,
      branch: null,
      headSha: null,
      statusShort: '',
      changedFiles: [],
      diffStat: null,
      diffExcerpt: null,
      truncated: false,
      error: null,
    };
    try {
      const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
      snap.isRepo = inside === 'true';
    } catch {
      snap.error = 'not a Git repository';
      return snap;
    }
    if (!snap.isRepo) return snap;
    try {
      snap.headSha = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
      snap.branch = (await git(cwd, ['branch', '--show-current']).catch(() => '')).trim() || null;
      snap.statusShort = await git(cwd, ['status', '--short', '--untracked-files=all']);
      if (phase === 'before') return snap;

      const from = base ?? snap.headSha ?? EMPTY_TREE;
      const nameStatus = await git(cwd, ['diff', '--name-status', from]);
      const tracked = nameStatus
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/\t/g, ' '));
      const untrackedPaths = snap.statusShort
        .split('\n')
        .filter((l) => l.startsWith('?? '))
        .map((l) => l.slice(3));
      snap.changedFiles = [...tracked, ...untrackedPaths.map((p) => `A ${p} (untracked)`)];
      snap.diffStat = (await git(cwd, ['diff', '--stat=120', from])).trim() || null;
      let diff = await git(cwd, ['diff', '--no-ext-diff', '-U2', from, '--', '.', ...SECRET_PATHSPECS], 16 * 1024 * 1024);
      // New files Claude created are untracked; include their (bounded, non-secret) content too.
      for (const p of untrackedPaths.filter((p) => !SECRET_PATH.test(p)).slice(0, UNTRACKED_CONTENT_FILES)) {
        if (diff.length > DIFF_EXCERPT_MAX) break;
        diff += await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', p], 1024 * 1024, [0, 1]).catch(() => '');
      }
      snap.truncated = diff.length > DIFF_EXCERPT_MAX;
      snap.diffExcerpt = (snap.truncated ? diff.slice(0, DIFF_EXCERPT_MAX) : diff) || null;
    } catch (err) {
      snap.error = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'git failed';
    }
    return snap;
  }
}
