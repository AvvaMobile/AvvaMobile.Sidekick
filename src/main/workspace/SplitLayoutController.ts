import {
  DEFAULT_LAYOUT_MODE,
  clampSplitRatio,
  computeLayoutGeometry,
  isGptHidden,
  isLayoutMode,
  isValidSplitRatio,
  modeRatio,
  type LayoutMode,
  type Rect,
  type SplitGeometry,
  type SplitRatio,
} from '../../domain/layout/splitPane';

/** Where per-Workspace split ratios are persisted (AppStateStore). */
export interface SplitRatioStore {
  getSplitRatio(workspaceId: string): SplitRatio;
  setSplitRatio(workspaceId: string, ratio: SplitRatio): void;
  getLayoutMode(workspaceId: string): LayoutMode;
  setLayoutMode(workspaceId: string, mode: LayoutMode): void;
}

/** The part of a ChatGPT WebContentsView the layout is allowed to touch: geometry and visibility only. */
export interface LayoutView {
  setBounds(bounds: Rect): void;
  setVisible(visible: boolean): void;
}

/**
 * Owns the ChatGPT/development split for every Workspace.
 *
 * Resizing and Workspace switching only call setBounds/setVisible on existing views; they never
 * navigate, reload or recreate a view and never touch terminal/PTY or Claude state (D015, D022).
 */
export class SplitLayoutController {
  private readonly views = new Map<string, LayoutView>();
  private readonly ratios = new Map<string, SplitRatio>();
  private readonly modes = new Map<string, LayoutMode>();
  private active: string | null = null;
  private suppressed = false;

  constructor(
    private readonly store: SplitRatioStore,
    private readonly getWorkArea: () => Rect,
    /** Geometry of the visible split after every change; null while no ChatGPT view is shown. */
    private readonly onVisibleGeometry: (geometry: SplitGeometry | null) => void = () => {},
  ) {}

  register(workspaceId: string, view: LayoutView): void {
    this.views.set(workspaceId, view);
    this.ratios.set(workspaceId, this.store.getSplitRatio(workspaceId));
    this.modes.set(workspaceId, this.store.getLayoutMode(workspaceId));
    if (workspaceId !== this.active) view.setVisible(false);
  }

  unregister(workspaceId: string): void {
    this.views.delete(workspaceId);
    this.ratios.delete(workspaceId);
    this.modes.delete(workspaceId);
    if (this.active === workspaceId) {
      this.active = null;
      this.onVisibleGeometry(null);
    }
  }

  get activeWorkspaceId(): string | null {
    return this.active;
  }

  /** Shows `workspaceId`'s view at its own saved split; hides every other Workspace's view. */
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

  get activeMode(): LayoutMode {
    if (!this.active) throw new Error('no active workspace');
    return this.modes.get(this.active) ?? DEFAULT_LAYOUT_MODE;
  }

  /** Preset button: switches the active Workspace's mode and persists it. The dragged ratio is kept for later `custom`. */
  setMode(mode: LayoutMode): void {
    if (!this.active) throw new Error('no active workspace');
    if (!isLayoutMode(mode)) throw new Error('invalid layout mode');
    this.modes.set(this.active, mode);
    this.store.setLayoutMode(this.active, mode);
    this.views.get(this.active)!.setVisible(this.shown(this.active));
    this.relayout();
  }

  private shown(workspaceId: string): boolean {
    return !this.suppressed && !isGptHidden(this.modes.get(workspaceId) ?? DEFAULT_LAYOUT_MODE);
  }

  /** Effective (clamped) ratio of the active Workspace for the current work-area width. */
  getActiveRatio(): SplitRatio {
    if (!this.active) throw new Error('no active workspace');
    return clampSplitRatio(modeRatio(this.activeMode, this.ratios.get(this.active)!), this.getWorkArea().width);
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
    if (!this.active) return this.onVisibleGeometry(null);
    const mode = this.activeMode;
    const geometry = computeLayoutGeometry(this.getWorkArea(), mode, this.ratios.get(this.active)!);
    // Hidden GPT: leave its bounds alone, it only gets setVisible(false) (no relayout of the page).
    if (!isGptHidden(mode)) this.views.get(this.active)!.setBounds(geometry.chatgpt);
    // The relay buttons sit on the divider: no divider, no buttons.
    const hasDivider = mode !== 'gpt-hidden' && mode !== 'terminal-hidden';
    this.onVisibleGeometry(this.suppressed || !hasDivider ? null : geometry);
  }

  private update(ratio: number, persist: boolean): SplitRatio {
    if (!this.active) throw new Error('no active workspace');
    if (!isValidSplitRatio(ratio)) throw new Error('invalid split ratio');
    const clamped = clampSplitRatio(ratio, this.getWorkArea().width);
    this.ratios.set(this.active, clamped);
    // Dragging the divider always makes the layout custom (and un-hides nothing: the divider only exists while both panes show).
    this.modes.set(this.active, 'custom');
    this.relayout();
    if (persist) {
      this.store.setSplitRatio(this.active, clamped);
      this.store.setLayoutMode(this.active, 'custom');
    }
    return clamped;
  }
}
