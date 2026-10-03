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
