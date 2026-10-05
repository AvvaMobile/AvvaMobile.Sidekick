import { execFile } from 'node:child_process';
import type { GithubAccess, GithubPermission } from '../../shared/github';
import { parseGithubRepository } from '../../shared/github';

export interface GithubCheckDeps {
  /** A GitHub token from the user's existing authentication, or null when not connected. */
  getToken(): Promise<string | null>;
  fetch: typeof fetch;
  now(): Date;
}

interface RepoPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
}

export function permissionLevel(p: unknown): GithubPermission | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const x = p as RepoPermissions;
  if (x.admin === true) return 'admin';
  if (x.maintain === true) return 'maintain';
  if (x.push === true) return 'write';
  if (x.triage === true) return 'triage';
  if (x.pull === true) return 'read';
  return undefined;
}

/**
 * Checks, through the authenticated GitHub REST API, that the repository exists and the current user can read it.
 * No shell is involved and the token never leaves this function. Read access is enough for `accessible`.
 */
export async function checkGithubAccess(repository: string, deps: GithubCheckDeps): Promise<GithubAccess> {
  const checkedAt = deps.now().toISOString();
  const repo = parseGithubRepository(repository);
  if (!repo) return { status: 'error', checkedAt };
  let token: string | null;
  try {
    token = await deps.getToken();
  } catch {
    token = null;
  }
  if (!token) return { status: 'auth-required', checkedAt };
  try {
    const [owner, name] = repo.split('/') as [string, string];
    const res = await deps.fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AvvaMobile-Sidekick',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { permissions?: unknown } | null;
      const permission = permissionLevel(body?.permissions);
      return permission ? { status: 'accessible', permission, checkedAt } : { status: 'accessible', checkedAt };
    }
    if (res.status === 401) return { status: 'auth-required', checkedAt };
    if (res.status === 404) return { status: 'not-found', checkedAt };
    // 403 is also rate limiting: that is a failed check, not proof of no access.
    if (res.status === 403) return { status: res.headers.get('x-ratelimit-remaining') === '0' ? 'error' : 'no-access', checkedAt };
    return { status: 'error', checkedAt };
  } catch {
    return { status: 'error', checkedAt };
  }
}

/** Reuses an existing GitHub login: GH_TOKEN / GITHUB_TOKEN, else the GitHub CLI's token (fixed arguments only). */
export function defaultGithubToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = (env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  const PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { env: { ...env, PATH }, timeout: 5_000, windowsHide: true }, (error, stdout) => {
      const t = error ? '' : String(stdout).trim();
      resolve(t || null);
    });
  });
}

export interface GithubStore {
  workspace(id: string): { githubRepository?: string | null; githubAccess?: GithubAccess | null } | undefined;
  updateWorkspace(id: string, patch: { githubRepository?: string | null; githubAccess?: GithubAccess | null }): void;
}

/** Saves the repository (no authentication needed). A new or cleared value invalidates the old verification. */
export function setGithubRepository(store: GithubStore, id: string, repository: string | null): void {
  if ((store.workspace(id)?.githubRepository ?? null) === repository) return;
  store.updateWorkspace(id, { githubRepository: repository, githubAccess: null });
}

/**
 * Verifies the Workspace's saved repository and records the result on that Workspace. The result is dropped when the
 * repository was changed or cleared while the check was in flight, so a stale answer never lands on a new value.
 */
export async function verifyWorkspaceGithub(store: GithubStore, workspaceId: string, deps: GithubCheckDeps): Promise<GithubAccess | null> {
  const repo = store.workspace(workspaceId)?.githubRepository;
  if (!repo) return null;
  const result = await checkGithubAccess(repo, deps);
  const now = store.workspace(workspaceId);
  if (!now || now.githubRepository !== repo) return null;
  store.updateWorkspace(workspaceId, { githubAccess: result });
  return result;
}
