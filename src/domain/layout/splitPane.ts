/**
 * Split-pane geometry for the main work area: ChatGPT (left) | splitter | development pane (right).
 * Pure functions shared by the trusted renderer (splitter drag) and the main process
 * (ChatGPT WebContentsView bounds), so both sides always agree on the geometry.
 */

/** Fraction of the work area given to the ChatGPT column. */
export type SplitRatio = number;

export const DEFAULT_SPLIT_RATIO: SplitRatio = 0.6;
export const MIN_CHATGPT_WIDTH = 360;
export const MIN_DEV_PANE_WIDTH = 320;
export const SPLITTER_WIDTH = 6;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitGeometry {
  chatgpt: Rect;
  splitter: Rect;
  devPane: Rect;
}

export function isValidSplitRatio(value: unknown): value is SplitRatio {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

/**
 * Clamps a ratio so neither column drops below its minimum width for the given work-area width.
 * When the work area is too narrow for both minimums, space is shared proportionally to the minimums.
 */
export function clampSplitRatio(ratio: number, workAreaWidth: number): SplitRatio {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : DEFAULT_SPLIT_RATIO;
  const usable = workAreaWidth - SPLITTER_WIDTH;
  if (!(usable > 0)) return isValidSplitRatio(r) ? r : DEFAULT_SPLIT_RATIO;
  if (usable < MIN_CHATGPT_WIDTH + MIN_DEV_PANE_WIDTH) return MIN_CHATGPT_WIDTH / (MIN_CHATGPT_WIDTH + MIN_DEV_PANE_WIDTH);
  const min = MIN_CHATGPT_WIDTH / usable;
  const max = 1 - MIN_DEV_PANE_WIDTH / usable;
  return Math.min(max, Math.max(min, r));
}

/** Ratio for a splitter dragged to `pointerX` (relative to the work area's left edge). */
export function ratioFromPointer(pointerX: number, workAreaWidth: number): SplitRatio {
  const usable = workAreaWidth - SPLITTER_WIDTH;
  if (!(usable > 0)) return DEFAULT_SPLIT_RATIO;
  return clampSplitRatio((pointerX - SPLITTER_WIDTH / 2) / usable, workAreaWidth);
}

/** Integer pixel geometry for a work area at (`area.x`, `area.y`). */
export function computeSplitGeometry(area: Rect, ratio: number): SplitGeometry {
  const usable = Math.max(0, area.width - SPLITTER_WIDTH);
  const chatWidth = Math.round(usable * clampSplitRatio(ratio, area.width));
  const devWidth = Math.max(0, usable - chatWidth);
  return {
    chatgpt: { x: area.x, y: area.y, width: chatWidth, height: area.height },
    splitter: { x: area.x + chatWidth, y: area.y, width: SPLITTER_WIDTH, height: area.height },
    devPane: { x: area.x + chatWidth + SPLITTER_WIDTH, y: area.y, width: devWidth, height: area.height },
  };
}

/**
 * Per-Workspace layout: one of five ratio presets (two hide a pane) or a manually dragged `custom` ratio.
 * Presets are ratios, not pixels: they reflow with the window and still honour the pane minimums.
 */
export type LayoutMode = 'gpt-hidden' | 'split-20-80' | 'split-50-50' | 'split-80-20' | 'terminal-hidden' | 'custom';

export const PRESET_MODES = ['gpt-hidden', 'split-20-80', 'split-50-50', 'split-80-20', 'terminal-hidden'] as const;
export const DEFAULT_LAYOUT_MODE: LayoutMode = 'custom';

const MODE_RATIO: Partial<Record<LayoutMode, number>> = { 'split-20-80': 0.2, 'split-50-50': 0.5, 'split-80-20': 0.8 };

export function isLayoutMode(value: unknown): value is LayoutMode {
  return value === 'custom' || (PRESET_MODES as readonly unknown[]).includes(value);
}

export function isGptHidden(mode: LayoutMode): boolean {
  return mode === 'gpt-hidden';
}

export function isTerminalHidden(mode: LayoutMode): boolean {
  return mode === 'terminal-hidden';
}

/** Ideal ChatGPT share for a mode; `customRatio` (the last dragged split) applies to `custom` and to hidden modes' fallback. */
export function modeRatio(mode: LayoutMode, customRatio: number): number {
  return MODE_RATIO[mode] ?? customRatio;
}

/** Geometry for a mode. A hidden pane gets zero width and no splitter; the visible pane takes the whole area. */
export function computeLayoutGeometry(area: Rect, mode: LayoutMode, customRatio: number): SplitGeometry {
  if (mode === 'gpt-hidden') {
    return {
      chatgpt: { x: area.x, y: area.y, width: 0, height: area.height },
      splitter: { x: area.x, y: area.y, width: 0, height: area.height },
      devPane: { ...area },
    };
  }
  if (mode === 'terminal-hidden') {
    return {
      chatgpt: { ...area },
      splitter: { x: area.x + area.width, y: area.y, width: 0, height: area.height },
      devPane: { x: area.x + area.width, y: area.y, width: 0, height: area.height },
    };
  }
  return computeSplitGeometry(area, modeRatio(mode, customRatio));
}
