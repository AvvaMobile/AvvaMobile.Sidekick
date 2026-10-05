import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT_RATIO,
  MIN_CHATGPT_WIDTH,
  MIN_DEV_PANE_WIDTH,
  SPLITTER_WIDTH,
  clampSplitRatio,
  computeLayoutGeometry,
  computeSplitGeometry,
  isLayoutMode,
  isValidSplitRatio,
  ratioFromPointer,
} from '../splitPane';

const area = (width: number) => ({ x: 0, y: 0, width, height: 900 });

describe('split pane geometry', () => {
  it('validates ratios', () => {
    expect(isValidSplitRatio(0.5)).toBe(true);
    for (const bad of [0, 1, -0.1, 1.2, Number.NaN, Infinity, '0.5', null, undefined]) expect(isValidSplitRatio(bad)).toBe(false);
  });

  it('enforces minimum widths on both sides', () => {
    const w = 1440;
    const left = computeSplitGeometry(area(w), 0.01);
    expect(left.chatgpt.width).toBeGreaterThanOrEqual(MIN_CHATGPT_WIDTH);
    const right = computeSplitGeometry(area(w), 0.99);
    expect(right.devPane.width).toBeGreaterThanOrEqual(MIN_DEV_PANE_WIDTH);
  });

  it('columns + splitter tile the work area exactly with no overlap', () => {
    for (const r of [0.2, 0.5, 0.6, 0.83]) {
      const g = computeSplitGeometry({ x: 72, y: 40, width: 1301, height: 800 }, r);
      expect(g.chatgpt.x).toBe(72);
      expect(g.splitter.x).toBe(g.chatgpt.x + g.chatgpt.width);
      expect(g.devPane.x).toBe(g.splitter.x + SPLITTER_WIDTH);
      expect(g.chatgpt.width + SPLITTER_WIDTH + g.devPane.width).toBe(1301);
      expect(Number.isInteger(g.chatgpt.width)).toBe(true);
    }
  });

  it('falls back to default for invalid ratios and shares space on very narrow windows', () => {
    expect(clampSplitRatio(Number.NaN, 1440)).toBe(DEFAULT_SPLIT_RATIO);
    const narrow = clampSplitRatio(0.9, 400);
    expect(narrow).toBeCloseTo(MIN_CHATGPT_WIDTH / (MIN_CHATGPT_WIDTH + MIN_DEV_PANE_WIDTH));
  });

  it('maps pointer position to a clamped ratio', () => {
    const w = 1206;
    expect(ratioFromPointer(600 + SPLITTER_WIDTH / 2, w)).toBeCloseTo(0.5);
    expect(ratioFromPointer(0, w)).toBeCloseTo(MIN_CHATGPT_WIDTH / (w - SPLITTER_WIDTH));
    expect(ratioFromPointer(w, w)).toBeCloseTo(1 - MIN_DEV_PANE_WIDTH / (w - SPLITTER_WIDTH));
  });

  it('layout modes: presets are ratios, hidden panes get zero width, minimums still apply', () => {
    const a = area(2006);
    expect(computeLayoutGeometry(a, 'split-50-50', 0.3).chatgpt.width).toBe(1000);
    expect(computeLayoutGeometry(a, 'custom', 0.3).chatgpt.width).toBe(Math.round(2000 * 0.3));
    const gptHidden = computeLayoutGeometry(a, 'gpt-hidden', 0.3);
    expect(gptHidden.chatgpt.width).toBe(0);
    expect(gptHidden.devPane).toEqual(a);
    const termHidden = computeLayoutGeometry(a, 'terminal-hidden', 0.3);
    expect(termHidden.chatgpt).toEqual(a);
    expect(termHidden.devPane.width).toBe(0);
    expect(computeLayoutGeometry(area(1206), 'split-20-80', 0.5).chatgpt.width).toBeGreaterThanOrEqual(MIN_CHATGPT_WIDTH);
    expect(computeLayoutGeometry(area(1206), 'split-80-20', 0.5).devPane.width).toBeGreaterThanOrEqual(MIN_DEV_PANE_WIDTH);
    expect(isLayoutMode('split-50-50')).toBe(true);
    expect(isLayoutMode('nope')).toBe(false);
  });
});
