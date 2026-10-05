export type GithubAccessStatus = 'unchecked' | 'accessible' | 'no-access' | 'not-found' | 'auth-required' | 'error';
export type GithubPermission = 'read' | 'triage' | 'write' | 'maintain' | 'admin';

/** Last known result of a repository access check. Never authoritative: permissions change, so it is re-checked on request. */
export interface GithubAccess {
  status: GithubAccessStatus;
  permission?: GithubPermission;
  checkedAt?: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Normalizes a GitHub repository reference to `owner/repo`. Accepts `owner/repo`, `https://github.com/owner/repo(.git)`
 * and `git@github.com:owner/repo.git`. Returns null when it is not a syntactically valid repository.
 */
export function parseGithubRepository(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.length === 0 || s.length > 200) return null;
  const url = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+)$/i.exec(s);
  if (url) s = url[1]!;
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = s.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return `${owner}/${repo}`;
}
