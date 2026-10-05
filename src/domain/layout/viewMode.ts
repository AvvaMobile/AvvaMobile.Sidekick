/**
 * The three views of a Workspace. A view only decides which surfaces are visible and where; the
 * Workspace's ChatGPT view, PTY, Claude session, task and saved split ratio are never touched by it.
 *
 * - chatgpt-focus: ChatGPT fills the work area above a slim Claude status bar; the terminal stays alive, hidden.
 * - split:         ChatGPT | terminal with one draggable splitter (the Workspace's saved ratio).
 * - claude-focus:  the terminal fills the work area; the ChatGPT view stays alive, hidden.
 */
import { computeSplitGeometry, type Rect } from './splitPane';

export type ViewMode = 'chatgpt-focus' | 'split' | 'claude-focus';
export const VIEW_MODES: readonly ViewMode[] = ['chatgpt-focus', 'split', 'claude-focus'];
export const DEFAULT_VIEW_MODE: ViewMode = 'split';

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'chatgpt-focus' || value === 'split' || value === 'claude-focus';
}

/** Height of the Claude status bar under ChatGPT in ChatGPT Focus. */
export const STATUS_BAR_HEIGHT = 34;

export interface ViewGeometry {
  /** Where the ChatGPT view goes; null = hidden (Claude Focus). */
  chatgpt: Rect | null;
  /** Draggable divider; Split only. */
  splitter: Rect | null;
  /** Frame of the development pane. It keeps a real size while hidden so xterm/PTY never reflow to ~0 columns. */
  devPane: Rect;
  devPaneVisible: boolean;
  /** Claude status bar; ChatGPT Focus only. */
  statusBar: Rect | null;
}

export function computeViewGeometry(area: Rect, viewMode: ViewMode, ratio: number): ViewGeometry {
  const split = computeSplitGeometry(area, ratio);
  if (viewMode === 'split') return { chatgpt: split.chatgpt, splitter: split.splitter, devPane: split.devPane, devPaneVisible: true, statusBar: null };
  if (viewMode === 'claude-focus') return { chatgpt: null, splitter: null, devPane: { ...area }, devPaneVisible: true, statusBar: null };
  const barH = Math.min(STATUS_BAR_HEIGHT, area.height);
  const chatgpt: Rect = { ...area, height: Math.max(0, area.height - barH) };
  return {
    chatgpt,
    splitter: null,
    // The hidden terminal keeps the size it has in the split.
    devPane: split.devPane,
    devPaneVisible: false,
    statusBar: { x: area.x, y: area.y + chatgpt.height, width: area.width, height: barH },
  };
}

/** Ideal ChatGPT share of the removed split-layout presets (saved by older versions as `uiState.layoutMode`). */
const LEGACY_PRESET_RATIO: Record<string, number> = { 'split-20-80': 0.2, 'split-50-50': 0.5, 'split-80-20': 0.8 };

export function legacyPresetRatio(layoutMode: unknown): number | undefined {
  return typeof layoutMode === 'string' ? LEGACY_PRESET_RATIO[layoutMode] : undefined;
}

/** View for a record that has no saved `viewMode`: the old hidden-pane presets map to their focus views, anything else is Split. */
export function legacyViewMode(layoutMode: unknown): ViewMode {
  if (layoutMode === 'terminal-hidden') return 'chatgpt-focus';
  if (layoutMode === 'gpt-hidden') return 'claude-focus';
  return DEFAULT_VIEW_MODE;
}
