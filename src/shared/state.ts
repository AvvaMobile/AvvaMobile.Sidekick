import type { ViewMode } from '../domain/layout/viewMode';
import type { EffortChoice, ModelChoice } from './models';
/**
 * Serializable view state shared by the main process and the trusted shell renderer.
 * Everything here is keyed by workspaceId; the renderer never receives another Workspace's
 * data under the wrong id (D015, D022).
 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'review_pending'
  | 'review_sent'
  | 'interrupted';

/** How the Claude process itself ended (kept when status later moves to review_pending/review_sent). */
export type TaskOutcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type AttentionState = 'none' | 'completed' | 'failed';

export interface ReviewView {
  status: 'pending' | 'sending' | 'sent' | 'failed';
  lastError: string | null;
  body: string;
}

/** The latest completed Claude result that can still be handed to ChatGPT (survives a task running now). */
export interface LatestReviewView extends ReviewView {
  taskId: string;
}

export interface TaskView {
  id: string;
  status: TaskStatus;
  outcome: TaskOutcome | null;
  prompt: string;
  createdAt: string;
  error: string | null;
  review: ReviewView | null;
}

export interface WorkspaceView {
  id: string;
  name: string;
  projectPath: string;
  color: string;
  initial: string;
  /** Custom icon as a small PNG data URL, or null for the colored initial. */
  iconUrl: string | null;
  claudeSessionId: string | null;
  /** Model of the terminal's Claude Code (the explicit choice, else the default from the user's settings). */
  model: ModelChoice | null;
  /** Effort level of the terminal's Claude Code (the explicit choice; null = Claude Code's own default). */
  effort: EffortChoice | null;
  splitRatio: number;
  /** This Workspace's view: ChatGPT Focus / Split / Claude Focus. */
  viewMode: ViewMode;
  attention: AttentionState;
  chatgpt: { loggedIn: boolean | null };
  task: TaskView | null;
  latestReview: LatestReviewView | null;
  terminal: { running: boolean; error: string | null };
}

/** One row of the Projects start page: every saved Workspace, open in a tab or not. */
export interface ProjectEntry {
  id: string;
  name: string;
  projectPath: string;
  open: boolean;
}

export interface ShellState {
  /** Workspaces that have a tab. */
  workspaces: WorkspaceView[];
  /** All saved Workspaces, most recently opened first. */
  projects: ProjectEntry[];
  activeWorkspaceId: string | null;
}

export interface ToastMessage {
  id: string;
  workspaceId: string;
  kind: 'success' | 'error' | 'info';
  title: string;
  body: string;
}

/** Support link (Help menu and the one-time popup). Opened by main only; the renderer never passes a URL. */
export const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/muratyilmaz';

export type ShellCommand = 'coffee-prompt' | 'setup-prompt' | 'new-workspace' | 'projects-opened' | 'fullscreen-enter' | 'fullscreen-leave';

/** Fixed IPC channel names for the shell preload (no generic channel access). */
export const SHELL_CHANNELS = {
  state: 'shell:state',
  terminalData: 'shell:terminal-data',
  toast: 'shell:toast',
  command: 'shell:command',
  /** Opens a settings screen (payload: `SettingsTarget`). */
  openSettings: 'shell:open-settings',
} as const;
