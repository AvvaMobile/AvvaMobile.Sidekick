import { describe, expect, it } from 'vitest';
import { computeSplitGeometry, type Rect } from '../splitPane';
import { DEFAULT_VIEW_MODE, STATUS_BAR_HEIGHT, VIEW_MODES, computeViewGeometry, isViewMode, legacyPresetRatio, legacyViewMode } from '../viewMode';

const area: Rect = { x: 0, y: 44, width: 1500, height: 900 };

describe('views', () => {
  it('there are exactly three: ChatGPT Focus, Split, Claude Focus', () => {
    expect([...VIEW_MODES]).toEqual(['chatgpt-focus', 'split', 'claude-focus']);
    expect(['grid', 'overview', 'focus', 'split-50-50', undefined].some(isViewMode)).toBe(false);
    expect(DEFAULT_VIEW_MODE).toBe('split');
  });

  it('Split is the split geometry for the Workspace ratio: both panes, divider, no status bar', () => {
    const v = computeViewGeometry(area, 'split', 0.72);
    const g = computeSplitGeometry(area, 0.72);
    expect(v.chatgpt).toEqual(g.chatgpt);
    expect(v.splitter).toEqual(g.splitter);
    expect(v.devPane).toEqual(g.devPane);
    expect(v.devPaneVisible).toBe(true);
    expect(v.statusBar).toBeNull();
  });

  it('ChatGPT Focus shows ChatGPT above a slim status bar and hides (but sizes) the terminal', () => {
    const v = computeViewGeometry(area, 'chatgpt-focus', 0.72);
    expect(v.chatgpt).toEqual({ ...area, height: area.height - STATUS_BAR_HEIGHT });
    expect(v.statusBar).toEqual({ x: 0, y: area.y + area.height - STATUS_BAR_HEIGHT, width: area.width, height: STATUS_BAR_HEIGHT });
    expect(v.devPaneVisible).toBe(false);
    expect(v.devPane.width).toBeGreaterThan(300);
    expect(v.splitter).toBeNull();
  });

  it('Claude Focus gives the terminal the whole area and hides ChatGPT', () => {
    const v = computeViewGeometry(area, 'claude-focus', 0.72);
    expect(v.chatgpt).toBeNull();
    expect(v.devPane).toEqual(area);
    expect(v.devPaneVisible).toBe(true);
    expect(v.splitter).toBeNull();
    expect(v.statusBar).toBeNull();
  });

  it('old layout presets map to a view and a ratio', () => {
    expect(['terminal-hidden', 'gpt-hidden', 'split-20-80', 'split-50-50', 'split-80-20', 'custom', undefined, 'junk'].map(legacyViewMode)).toEqual([
      'chatgpt-focus', 'claude-focus', 'split', 'split', 'split', 'split', 'split', 'split',
    ]);
    expect(['split-20-80', 'split-50-50', 'split-80-20', 'gpt-hidden', 'terminal-hidden', 'custom', undefined].map(legacyPresetRatio)).toEqual([0.2, 0.5, 0.8, undefined, undefined, undefined, undefined]);
  });
});
