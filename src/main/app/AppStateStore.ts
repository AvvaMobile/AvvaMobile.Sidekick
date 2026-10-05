import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameWithRetry } from './renameWithRetry';
import { DEFAULT_SPLIT_RATIO, isValidSplitRatio, type SplitRatio } from '../../domain/layout/splitPane';
import { DEFAULT_PROMPT_SUFFIX } from '../../domain/handoff/promptSuffix';
import { isViewMode, legacyPresetRatio, legacyViewMode, type ViewMode } from '../../domain/layout/viewMode';
import type { ReviewPacket } from '../../domain/review/reviewPacket';
import type { TaskRecord } from '../../domain/task/task';
import { isPermutation } from '../../domain/workspace/order';
import { isOpen, type WorkspaceRecord } from '../../domain/workspace/workspace';
import type { SplitRatioStore } from '../workspace/SplitLayoutController';

/**
 * Persisted AppState (docs/ARCHITECTURE.md §15). Atomic writes, schema version, corrupt-file recovery.
 * Runtime objects (views, PTYs, processes) are never persisted.
 */
const APP_STATE_SCHEMA_VERSION = 1;
const TASKS_PER_WORKSPACE = 20;

export interface AppState {
  schemaVersion: number;
  workspaces: WorkspaceRecord[];
  tasks: TaskRecord[];
  reviewPackets: ReviewPacket[];
  activeWorkspaceId: string | null;
  /** Global preferences (optional on disk; older files have none). */
  preferences?: Preferences;
}

export interface Preferences {
  /** Auto-send a ready Claude Prompt when the user asked ChatGPT to send it (D034). Default on. */
  autoSendOnRequest: boolean;
  /** The one-time "Buy me a coffee" popup has been shown. */
  coffeePromptShown: boolean;
  /** The one-time requirements popup (D037) has been shown. */
  setupPromptShown: boolean;
  /** Global "Append to Claude prompts" text (optional on disk; absent = default, '' = the user cleared it). */
  claudePromptSuffix: string;
}

const defaultPreferences = (): Preferences => ({ autoSendOnRequest: true, coffeePromptShown: false, setupPromptShown: false, claudePromptSuffix: DEFAULT_PROMPT_SUFFIX });

const empty = (): AppState => ({
  schemaVersion: APP_STATE_SCHEMA_VERSION,
  workspaces: [],
  tasks: [],
  reviewPackets: [],
  activeWorkspaceId: null,
  preferences: defaultPreferences(),
});

export class AppStateStore implements SplitRatioStore {
  private state: AppState;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 150,
    private readonly log: (line: string) => void = (line) => console.error(line),
    private readonly retryMs = 5_000,
  ) {
    this.state = this.load();
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  workspace(id: string): WorkspaceRecord | undefined {
    return this.state.workspaces.find((w) => w.id === id);
  }

  addWorkspace(w: WorkspaceRecord): void {
    this.state.workspaces.push(w);
    this.save();
  }

  updateWorkspace(id: string, patch: Partial<Omit<WorkspaceRecord, 'id'>>): void {
    const w = this.workspace(id);
    if (!w) throw new Error(`unknown workspace ${id}`);
    Object.assign(w, patch, { updatedAt: new Date().toISOString() });
    this.save();
  }

  removeWorkspace(id: string): void {
    this.state.workspaces = this.state.workspaces.filter((w) => w.id !== id);
    this.state.tasks = this.state.tasks.filter((t) => t.workspaceId !== id);
    this.state.reviewPackets = this.state.reviewPackets.filter((p) => p.workspaceId !== id);
    if (this.state.activeWorkspaceId === id) this.state.activeWorkspaceId = this.state.workspaces[0]?.id ?? null;
    this.save();
  }

  /** Persists a new tab order; `ids` must be a permutation of the open Workspace ids (closed ones keep their relative order after them). */
  reorderWorkspaces(ids: readonly string[]): boolean {
    const byOrder = [...this.state.workspaces].sort((a, b) => a.sidebarOrder - b.sidebarOrder);
    if (!isPermutation(byOrder.filter(isOpen).map((w) => w.id), ids)) return false;
    [...ids, ...byOrder.filter((w) => !isOpen(w)).map((w) => w.id)].forEach((id, i) => {
      this.workspace(id)!.sidebarOrder = i;
    });
    this.save();
    return true;
  }

  setActiveWorkspace(id: string | null): void {
    this.state.activeWorkspaceId = id;
    this.save();
  }

  preferences(): Preferences {
    return this.state.preferences ?? defaultPreferences();
  }

  setPreferences(patch: Partial<Preferences>): void {
    this.state.preferences = { ...this.preferences(), ...patch };
    this.save();
  }

  /**
   * A record saved while layout presets existed may carry a preset `layoutMode`; its ratio (20/50/80 %) was the
   * visible split then, so it continues as the saved ratio. Hidden-pane presets just use the stored ratio.
   */
  getSplitRatio(workspaceId: string): SplitRatio {
    const ui = this.workspace(workspaceId)?.uiState;
    const r = legacyPresetRatio(ui?.layoutMode) ?? ui?.splitRatio;
    return isValidSplitRatio(r) ? r : DEFAULT_SPLIT_RATIO;
  }

  /**
   * A dragged ratio replaces any legacy preset: `layoutMode` becomes `custom` (never removed), so an older
   * version, which still reads it, shows the same ratio after a rollback.
   */
  setSplitRatio(workspaceId: string, ratio: SplitRatio): void {
    const w = this.workspace(workspaceId);
    if (!w || !isValidSplitRatio(ratio)) return;
    const hasPreset = w.uiState.layoutMode !== undefined && w.uiState.layoutMode !== 'custom';
    if (w.uiState.splitRatio === ratio && !hasPreset) return;
    w.uiState = { ...w.uiState, splitRatio: ratio, ...(w.uiState.layoutMode !== undefined ? { layoutMode: 'custom' } : {}) };
    this.save();
  }

  /** Saved view of a Workspace; records without one derive it from the old preset (hidden pane → focus view), else Split. */
  getViewMode(workspaceId: string): ViewMode {
    const ui = this.workspace(workspaceId)?.uiState;
    return isViewMode(ui?.viewMode) ? ui.viewMode : legacyViewMode(ui?.layoutMode);
  }

  setViewMode(workspaceId: string, mode: ViewMode): void {
    const w = this.workspace(workspaceId);
    if (!w || !isViewMode(mode) || this.getViewMode(workspaceId) === mode) return;
    w.uiState = { ...w.uiState, viewMode: mode };
    this.save();
  }

  /** Inserts or replaces a task record (tasks are mutable records except their frozen prompt). */
  putTask(task: TaskRecord): void {
    const i = this.state.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.state.tasks[i] = task;
    else {
      this.state.tasks.push(task);
      const mine = this.state.tasks.filter((t) => t.workspaceId === task.workspaceId);
      if (mine.length > TASKS_PER_WORKSPACE) {
        const drop = new Set(mine.slice(0, mine.length - TASKS_PER_WORKSPACE).map((t) => t.id));
        this.state.tasks = this.state.tasks.filter((t) => !drop.has(t.id));
        this.state.reviewPackets = this.state.reviewPackets.filter((p) => !drop.has(p.taskId));
      }
    }
    this.save();
  }

  task(id: string | null | undefined): TaskRecord | undefined {
    return id ? this.state.tasks.find((t) => t.id === id) : undefined;
  }

  putReviewPacket(p: ReviewPacket): void {
    const i = this.state.reviewPackets.findIndex((x) => x.id === p.id);
    if (i >= 0) this.state.reviewPackets[i] = p;
    else this.state.reviewPackets.push(p);
    this.save();
  }

  reviewPacket(id: string | null | undefined): ReviewPacket | undefined {
    return id ? this.state.reviewPackets.find((p) => p.id === id) : undefined;
  }

  /** Writes immediately (application shutdown). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  save(): void {
    if (this.debounceMs <= 0) {
      if (!this.write()) this.scheduleRetry();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.write()) this.scheduleRetry();
    }, this.debounceMs);
  }

  /** A failed write (disk full, permissions, a locked file) is retried later, never in a tight loop. */
  private scheduleRetry(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.write()) this.scheduleRetry();
    }, this.retryMs);
    this.timer.unref?.();
  }

  /** True when the state reached the disk. */
  private write(): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameWithRetry(tmp, this.file);
      return true;
    } catch (err) {
      this.log(`state save failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private load(): AppState {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return empty();
    }
    try {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed?.schemaVersion !== APP_STATE_SCHEMA_VERSION || !Array.isArray(parsed.workspaces)) throw new Error('schema');
      const state: AppState = {
        schemaVersion: APP_STATE_SCHEMA_VERSION,
        workspaces: parsed.workspaces.filter((w) => w && typeof w.id === 'string' && typeof w.projectPath === 'string'),
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        reviewPackets: Array.isArray(parsed.reviewPackets) ? parsed.reviewPackets : [],
        activeWorkspaceId: typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null,
        preferences: {
          autoSendOnRequest: parsed.preferences?.autoSendOnRequest !== false,
          coffeePromptShown: parsed.preferences?.coffeePromptShown === true,
          setupPromptShown: parsed.preferences?.setupPromptShown === true,
          claudePromptSuffix: typeof parsed.preferences?.claudePromptSuffix === 'string' ? parsed.preferences.claudePromptSuffix : DEFAULT_PROMPT_SUFFIX,
        },
      };
      // Restart recovery (WORKFLOW §8): no child process survives a restart.
      for (const t of state.tasks) {
        if (t.status === 'queued' || t.status === 'running') {
          t.status = 'interrupted';
          t.outcome = 'interrupted';
          t.completedAt ??= new Date().toISOString();
          t.error ??= { code: 'interrupted', message: 'Workspace was closed while this task was running', retryable: false };
        }
        // A send that was in flight when the app closed is retryable.
      }
      for (const p of state.reviewPackets) if (p.deliveryStatus !== 'sent' && p.deliveryStatus !== 'pending') p.deliveryStatus = 'failed';
      if (state.activeWorkspaceId && !state.workspaces.some((w) => w.id === state.activeWorkspaceId)) state.activeWorkspaceId = null;
      return state;
    } catch {
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // ignore
      }
      return empty();
    }
  }
}
