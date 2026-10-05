import type { ViewMode } from '../../domain/layout/viewMode';
import type { AppSettings, AppSettingsPatch, ProjectSettings, ProjectSettingsPatch, SettingsTarget } from '../../shared/settings';
import type { BlockInfo, CopyKind, CopyTarget } from '../../shared/response';
import type { MicrophoneStatus, SetupCheck, SetupLink } from '../../shared/setup';
import type { ShellCommand, ShellState, ToastMessage } from '../../shared/state';

export type Result<T = object> = ({ ok: true } & T) | { ok: false; code?: string; detail?: string };

export interface WorkspaceApi {
  /** `process.platform` of the app (window chrome and shortcut labels differ on Windows). */
  platform: string;
  getState(): Promise<ShellState>;
  terminalSnapshot(id: string): Promise<string>;
  setOverlay(on: boolean): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  reorderWorkspaces(ids: string[]): Promise<Result>;
  workspaceContextMenu(id: string): Promise<void>;
  pickFolder(): Promise<{ path: string; name: string } | null>;
  createWorkspace(name: string, projectPath: string): Promise<Result<{ id: string }>>;
  removeWorkspace(id: string): Promise<Result>;
  closeWorkspace(id: string): Promise<Result>;
  setModel(id: string, model: string): Promise<Result>;
  /** null = Claude Code's default effort. */
  setEffort(id: string, effort: string | null): Promise<Result>;
  openWorkspace(id: string): Promise<Result>;
  projectContextMenu(id: string): Promise<void>;
  getProjectSettings(id: string): Promise<ProjectSettings | null>;
  updateProjectSettings(id: string, patch: ProjectSettingsPatch): Promise<Result<{ settings: ProjectSettings | null }>>;
  verifyGithub(id: string): Promise<Result<{ settings: ProjectSettings | null }>>;
  /** File dialog for a custom tab icon; `code: 'cancelled'` when the user closed it. */
  chooseIcon(id: string): Promise<Result>;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(patch: AppSettingsPatch): Promise<Result<{ settings: AppSettings }>>;
  revealUserData(): Promise<void>;
  sendToClaude(id: string): Promise<Result<{ taskId: string }>>;
  /** Cancels the user-requested auto-send countdown (D034). */
  cancelAutoSend(id: string): Promise<Result>;
  cancelTask(id: string): Promise<Result>;
  resetSession(id: string): Promise<Result>;
  /** Retries delivering the stored result to ChatGPT after an automatic delivery failed (never re-runs Claude). */
  retryReview(id: string, taskId: string): Promise<Result>;
  /** Code blocks of Claude's last completed response (for the Copy menu). */
  responseInfo(id: string): Promise<{ available: boolean; blocks: BlockInfo[] }>;
  /** Copies part of Claude's last response to the clipboard; `code: 'choose'` lists the blocks to pick from. */
  copyResponse(id: string, target: CopyTarget): Promise<Result<{ kind: CopyKind }> | { ok: false; code: 'choose'; blocks: BlockInfo[] }>;
  terminalInput(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalRestart(id: string): Promise<void>;
  setSplit(id: string, ratio: number, commit: boolean): void;
  /** ChatGPT Focus / Split / Claude Focus for a Workspace (visibility only). */
  setViewMode(id: string, mode: ViewMode): void;
  /** Opens the Buy Me a Coffee page in the default browser. */
  openCoffee(): Promise<void>;
  /** Requirements popup (D037): finds Claude Code and Git, reads the microphone permission. */
  checkSetup(): Promise<SetupCheck>;
  openSetupLink(key: SetupLink): Promise<void>;
  /** Asks for the microphone (macOS, first time) or opens the OS privacy settings; returns the new status. */
  requestMicrophone(): Promise<MicrophoneStatus>;
  diagnostics: Record<'state' | 'capture' | 'latestUser' | 'micStatus' | 'home' | 'submit', () => Promise<unknown>> & {
    insert(text: string): Promise<unknown>;
  };
  onState(cb: (s: ShellState) => void): () => void;
  onTerminalData(cb: (e: { workspaceId: string; data: string }) => void): () => void;
  onToast(cb: (t: ToastMessage) => void): () => void;
  onCommand(cb: (c: ShellCommand) => void): () => void;
  onOpenSettings(cb: (t: SettingsTarget) => void): () => void;
}

export const api = (window as unknown as { workspace: WorkspaceApi }).workspace;
