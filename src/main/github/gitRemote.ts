import { execFile } from 'node:child_process';
import { parseGithubRepository } from '../../shared/github';
import type { GithubStore } from './GithubAccessChecker';

/** Best effort: `owner/repo` of the folder's `origin` remote when it points at github.com; null otherwise (no git, not a repo, other host). */
export function detectGithubRemote(projectPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', projectPath, 'remote', 'get-url', 'origin'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : parseGithubRepository(String(stdout).trim()));
    });
  });
}

/**
 * Prefills the repository from the local remote, only while it was never set (`undefined`). A saved value, or one the
 * user cleared (`null`), is never touched. The remote is metadata discovery only: nothing is verified here.
 */
export async function prefillGithubRepository(
  store: { workspace(id: string): { githubRepository?: string | null; projectPath: string } | undefined; updateWorkspace: GithubStore['updateWorkspace'] },
  id: string,
  detect: (projectPath: string) => Promise<string | null> = detectGithubRemote,
): Promise<boolean> {
  const w = store.workspace(id);
  if (!w || w.githubRepository !== undefined) return false;
  const found = await detect(w.projectPath);
  if (!found || store.workspace(id)?.githubRepository !== undefined) return false;
  store.updateWorkspace(id, { githubRepository: found });
  return true;
}
