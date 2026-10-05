import type { WorkspaceView } from '../../shared/state';

export type SendIndicator = 'none' | 'ready' | 'sent' | 'waiting' | 'running';

export interface SendState {
  enabled: boolean;
  indicator: SendIndicator;
  /** Short status next to the button. */
  label: string;
  /** Tooltip / reason. */
  reason: string;
}

/** Send to Claude availability for the selected Workspace (only its own candidate counts). */
/** Start-page search: case-insensitive match on the project name only. */
export function filterProjects<T extends { name: string }>(projects: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : [...projects];
}

export function sendState(ws: WorkspaceView | null): SendState {
  if (!ws) return { enabled: false, indicator: 'none', label: '', reason: 'No Workspace selected' };
  const st = ws.task?.status;
  if (st === 'queued' || st === 'running') return { enabled: false, indicator: 'running', label: 'Claude running', reason: 'A Claude task is already running in this Workspace' };
  if (ws.sending) return { enabled: false, indicator: 'running', label: 'Sending…', reason: 'Starting Claude' };
  if (ws.chatgpt.generating) return { enabled: false, indicator: 'waiting', label: 'ChatGPT is responding…', reason: 'Wait for ChatGPT to finish its reply' };
  if (!ws.candidate) return { enabled: false, indicator: 'none', label: 'No prompt', reason: 'Ask ChatGPT for a ```claude-prompt block' };
  if (ws.candidate.alreadySent) return { enabled: false, indicator: 'sent', label: 'Already run', reason: 'This prompt already ran successfully; ask ChatGPT for a new one' };
  return { enabled: true, indicator: 'ready', label: 'Prompt ready', reason: 'Send the latest Claude Prompt block to Claude Code' };
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
