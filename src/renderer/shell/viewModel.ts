import type { WorkspaceView } from '../../shared/state';

/** Start-page search: case-insensitive match on the project name only. */
export function filterProjects<T extends { name: string }>(projects: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : [...projects];
}

export function shortPath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) return `~${m[1] ?? ''}`;
  const w = p.match(/^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/i);
  return w ? `~${w[1] ?? ''}` : p;
}

export type ClaudeStatus = 'idle' | 'running' | 'sending' | 'delivered' | 'delivery-failed' | 'failed';

/** Compact Claude state of a Workspace for the ChatGPT Focus status bar. */
export function claudeStatus(ws: WorkspaceView): ClaudeStatus {
  const task = ws.task;
  if (task?.status === 'queued' || task?.status === 'running') return 'running';
  // A succeeded task's result goes to ChatGPT by itself; only a failed delivery needs the user (Retry).
  if (ws.latestReview?.status === 'failed') return 'delivery-failed';
  if (ws.latestReview?.status === 'sending') return 'sending';
  if (task?.outcome === 'succeeded') return task.status === 'review_sent' ? 'delivered' : 'sending';
  return task?.outcome === 'failed' || ws.attention === 'failed' ? 'failed' : 'idle';
}
