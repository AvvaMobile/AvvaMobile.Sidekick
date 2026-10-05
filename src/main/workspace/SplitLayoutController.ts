import { clampSplitRatio, isValidSplitRatio, type Rect, type SplitRatio } from '../../domain/layout/splitPane';
import { DEFAULT_VIEW_MODE, computeViewGeometry, isViewMode, type ViewMode } from '../../domain/layout/viewMode';

/** Where per-Workspace split ratios and views are persisted (AppStateStore). */
export interface SplitRatioStore {
  getSplitRatio(workspaceId: string): SplitRatio;
  setSplitRatio(workspaceId: string, ratio: SplitRatio): void;
  getViewMode(workspaceId: string): ViewMode;
  setViewMode(workspaceId: string, mode: ViewMode): void;
}

/** The part of a ChatGPT WebContentsView the layout is allowed to touch: geometry and visibility only. */
export interface LayoutView {
  setBounds(bounds: Rect): void;
  setVisible(visible: boolean): void;
}

/**
 * Owns the ChatGPT/terminal layout for every Workspace: its view (ChatGPT Focus / Split / Claude Focus)
 * and its manual split ratio.
 *
 * Switching views, resizing and Workspace switching only call setBounds/setVisible on existing views; they
 * never navigate, reload or recreate a view and never touch terminal/PTY or Claude state (D015, D022).
 * The split ratio is only ever written by the Split divider.
 */
export class SplitLayoutController {
  private readonly views = new Map<string, LayoutView>();
  private readonly ratios = new Map<string, SplitRatio>();
  private readonly modes = new Map<string, ViewMode>();
  private active: string | null = null;
  private suppressed = false;

  constructor(
    private readonly store: SplitRatioStore,
    private readonly getWorkArea: () => Rect,
  ) {}

  register(workspaceId: string, view: LayoutView): void {
    this.views.set(workspaceId, view);
    this.ratios.set(workspaceId, this.store.getSplitRatio(workspaceId));
    this.modes.set(workspaceId, this.store.getViewMode(workspaceId));
    if (workspaceId !== this.active) view.setVisible(false);
  }

  unregister(workspaceId: string): void {
    this.views.delete(workspaceId);
    this.ratios.delete(workspaceId);
    this.modes.delete(workspaceId);
    if (this.active === workspaceId) {
      this.active = null;
    }
  }

  get activeWorkspaceId(): string | null {
    return this.active;
  }

  /** Shows `workspaceId`'s view in its own saved view and split; hides every other Workspace's view. */
  activate(workspaceId: string): SplitRatio {
    const view = this.views.get(workspaceId);
    if (!view) throw new Error(`unknown workspace ${workspaceId}`);
    for (const [id, v] of this.views) if (id !== workspaceId) v.setVisible(false);
    this.active = workspaceId;
    this.relayout();
    view.setVisible(this.shown(workspaceId));
    return this.getActiveRatio();
  }

  /**
   * Temporarily hides the active ChatGPT view (a trusted-shell modal needs the whole window).
   * Visibility only: the view keeps its page, conversation and process.
   */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    if (this.active) this.views.get(this.active)!.setVisible(this.shown(this.active));
    this.relayout();
  }

  viewModeOf(workspaceId: string): ViewMode {
    return this.modes.get(workspaceId) ?? DEFAULT_VIEW_MODE;
  }

  get activeViewMode(): ViewMode {
    if (!this.active) throw new Error('no active workspace');
    return this.viewModeOf(this.active);
  }

  /** View buttons: switches the active Workspace's view and persists it. The saved split ratio is untouched. */
  setViewMode(mode: ViewMode): void {
    if (!this.active) throw new Error('no active workspace');
    if (!isViewMode(mode)) throw new Error('invalid view mode');
    this.modes.set(this.active, mode);
    this.store.setViewMode(this.active, mode);
    this.views.get(this.active)!.setVisible(this.shown(this.active));
    this.relayout();
  }

  private geometry(workspaceId: string) {
    return computeViewGeometry(this.getWorkArea(), this.viewModeOf(workspaceId), this.ratios.get(workspaceId)!);
  }

  private shown(workspaceId: string): boolean {
    return !this.suppressed && this.geometry(workspaceId).chatgpt !== null;
  }

  /** Effective (clamped) ratio of the active Workspace for the current work-area width. */
  getActiveRatio(): SplitRatio {
    if (!this.active) throw new Error('no active workspace');
    return clampSplitRatio(this.ratios.get(this.active)!, this.getWorkArea().width);
  }

  /** Live drag update: resizes the active view immediately; nothing is persisted. */
  preview(ratio: number): SplitRatio {
    return this.update(ratio, false);
  }

  /** End of drag: resizes and persists the ratio for the active Workspace only. */
  commit(ratio: number): SplitRatio {
    return this.update(ratio, true);
  }

  /** Re-applies the active Workspace's geometry (window resize). */
  relayout(): void {
    if (!this.active) return;
    const geometry = this.geometry(this.active);
    // Hidden GPT: leave its bounds alone, it only gets setVisible(false) (no relayout of the page).
    if (geometry.chatgpt) this.views.get(this.active)!.setBounds(geometry.chatgpt);
  }

  private update(ratio: number, persist: boolean): SplitRatio {
    if (!this.active) throw new Error('no active workspace');
    if (!isValidSplitRatio(ratio)) throw new Error('invalid split ratio');
    // Only Split has a divider: the other views never rewrite a Workspace's saved ratio.
    if (this.activeViewMode !== 'split') return this.getActiveRatio();
    const clamped = clampSplitRatio(ratio, this.getWorkArea().width);
    this.ratios.set(this.active, clamped);
    this.relayout();
    if (persist) this.store.setSplitRatio(this.active, clamped);
    return clamped;
  }
}
