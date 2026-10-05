import type { GithubAccess } from './github';
import type { ModelChoice } from './models';

/** Everything the Project Settings screen shows and edits for one Workspace. */
export interface ProjectSettings {
  id: string;
  name: string;
  projectPath: string;
  color: string;
  /** Custom icon as a small PNG data URL, or null for the colored initial. */
  iconUrl: string | null;
  initial: string;
  /** The explicit model choice; null = the app default (Claude Code's own default model). */
  model: ModelChoice | null;
  /** Claude Code's default model from ~/.claude/settings.json, when it is one of the choices. */
  defaultModel: ModelChoice | null;
  /** Remembered ChatGPT conversation; null = ChatGPT home. */
  chatConversationUrl: string | null;
  claudeSessionId: string | null;
  /** GitHub repository as `owner/repo`, or null. */
  githubRepository: string | null;
  /** Last known access check for the repository (status 'unchecked' when never checked). */
  githubAccess: GithubAccess;
  /** A Claude task is running (path/model/session changes are refused meanwhile). */
  taskActive: boolean;
}

/**
 * Partial update of one Workspace's settings (`workspace:update-settings`). Every field is optional;
 * unknown fields are rejected. `icon: null` removes the custom icon (choosing one goes through a file dialog).
 * `chatConversationUrl: null` forgets the conversation and loads ChatGPT home.
 */
export interface ProjectSettingsPatch {
  name?: string;
  projectPath?: string;
  color?: string;
  model?: ModelChoice | null;
  chatConversationUrl?: string | null;
  icon?: null;
  /** Accepts `owner/repo` or a github.com URL; stored normalized. null clears it. */
  githubRepository?: string | null;
}

export interface AppSettings {
  autoSendOnRequest: boolean;
  developerMode: boolean;
  /** Read-only: Claude Code's default model from ~/.claude/settings.json (null when unset or not a known choice). */
  defaultModel: ModelChoice | null;
  version: string;
  userDataPath: string;
}

export interface AppSettingsPatch {
  autoSendOnRequest?: boolean;
  developerMode?: boolean;
}

/** Which settings screen a shell window should show (pushed by the main process). */
export type SettingsTarget = { kind: 'app' } | { kind: 'project'; workspaceId: string };
