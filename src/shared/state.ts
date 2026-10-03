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

export interface CandidateView {
  text: string;
  messageId: string | null;
  /** Same prompt text as the Workspace's most recent task. */
  alreadySent: boolean;
}

export interface ReviewView {
  status: 'pending' | 'sending' | 'sent' | 'failed';
  lastError: string | null;
  body: string;
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

/** One step of the ChatGPT <-> Claude flow, as observed (passively) or performed (buttons). */
export type FlowKind =
  | 'chatgpt_started' // ChatGPT began writing a reply
  | 'chatgpt_replied' // ChatGPT finished its reply
  | 'prompt_ready' // a Claude Prompt block is ready to send
  | 'sent_to_claude'
  | 'claude_finished' // Claude's turn ended (managed task or the user's own run in the terminal)
  | 'review_sent' // review packet handed to ChatGPT
  | 'review_failed';

export interface FlowEntry {
  seq: number;
  at: string;
  kind: FlowKind;
  /** Short human text (first line of a prompt, outcome, error). */
  detail: string;
  /** ChatGPT message the entry refers to (dedupes `prompt_ready` across restarts). */
  messageId?: string | null;
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
  attention: AttentionState;
  chatgpt: { generating: boolean; loggedIn: boolean | null };
  candidate: CandidateView | null;
  /** Send to Claude is capturing the prompt right now. */
  sending: boolean;
  task: TaskView | null;
  terminal: { running: boolean; error: string | null };
  /** The user asked ChatGPT to send the prompt to Claude: it is sent at `at` (ISO) unless cancelled (D034). */
  autoSend: { at: string } | null;
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
  debugMode: boolean;
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

export type ShellCommand = 'send-to-claude' | 'send-review' | 'coffee-prompt' | 'setup-prompt' | 'new-workspace' | 'projects-opened' | 'fullscreen-enter' | 'fullscreen-leave';

/** The two round relay buttons that sit on the ChatGPT/development divider (their own overlay view). */
export interface RelayButtonState {
  enabled: boolean;
  title: string;
}
export interface RelayState {
  claude: RelayButtonState;
  chatgpt: RelayButtonState;
}
export type RelayButton = keyof RelayState;

/** Fixed IPC channel names for the shell preload (no generic channel access). */
export const SHELL_CHANNELS = {
  state: 'shell:state',
  terminalData: 'shell:terminal-data',
  toast: 'shell:toast',
  command: 'shell:command',
  /** Opens a settings screen (payload: `SettingsTarget`). */
  openSettings: 'shell:open-settings',
} as const;
