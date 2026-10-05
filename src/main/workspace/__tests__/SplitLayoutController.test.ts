import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPLIT_RATIO, computeSplitGeometry, type LayoutMode, type Rect } from '../../../domain/layout/splitPane';
import { SplitLayoutController, type SplitRatioStore } from '../SplitLayoutController';

/** In-memory ratio store (the shell persists through AppStateStore). */
function memoryStore(): SplitRatioStore & { saved: Map<string, number>; modes: Map<string, LayoutMode> } {
  const saved = new Map<string, number>();
  const modes = new Map<string, LayoutMode>();
  return {
    saved,
    modes,
    getSplitRatio: (id) => saved.get(id) ?? DEFAULT_SPLIT_RATIO,
    setSplitRatio: (id, r) => void saved.set(id, r),
    getLayoutMode: (id) => modes.get(id) ?? 'custom',
    setLayoutMode: (id, m) => void modes.set(id, m),
  };
}

/** Fake view exposing the full surface a WebContentsView offers for reload/recreation, so we can prove none of it is used. */
function fakeView() {
  return {
    setBounds: vi.fn<(r: Rect) => void>(),
    setVisible: vi.fn<(v: boolean) => void>(),
    webContents: { loadURL: vi.fn(), reload: vi.fn(), close: vi.fn() },
  };
}

describe('SplitLayoutController', () => {
  let store: ReturnType<typeof memoryStore>;
  let area: Rect;
  beforeEach(() => {
    store = memoryStore();
    area = { x: 0, y: 0, width: 1446, height: 900 };
  });
  const make = () => new SplitLayoutController(store, () => area);

  it('resizing only updates bounds of the active view (no reload/recreate)', () => {
    const c = make();
    const a = fakeView();
    c.register('a', a);
    c.activate('a');
    a.setBounds.mockClear();
    c.preview(0.3);
    c.preview(0.31);
    c.commit(0.32);
    expect(a.setBounds).toHaveBeenCalledTimes(3);
    expect(a.setBounds.mock.calls.at(-1)![0]).toEqual(computeSplitGeometry(area, 0.32).chatgpt);
    expect(a.webContents.loadURL).not.toHaveBeenCalled();
    expect(a.webContents.reload).not.toHaveBeenCalled();
    expect(a.webContents.close).not.toHaveBeenCalled();
  });

  it('restores each workspace own split ratio when switching', () => {
    const c = make();
    const a = fakeView();
    const b = fakeView();
    c.register('a', a);
    c.register('b', b);
    c.activate('a');
    c.commit(0.35);
    c.activate('b');
    expect(a.setVisible).toHaveBeenLastCalledWith(false);
    expect(b.setVisible).toHaveBeenLastCalledWith(true);
    c.commit(0.7);
    expect(c.activate('a')).toBeCloseTo(0.35);
    expect(a.setBounds.mock.calls.at(-1)![0]).toEqual(computeSplitGeometry(area, 0.35).chatgpt);
    expect(c.activate('b')).toBeCloseTo(0.7);
    expect(b.setBounds.mock.calls.at(-1)![0]).toEqual(computeSplitGeometry(area, 0.7).chatgpt);
  });

  it('persists committed ratios per workspace; previews are not persisted', () => {
    const c = make();
    c.register('a', fakeView());
    c.register('b', fakeView());
    c.activate('a');
    c.commit(0.4);
    c.preview(0.5);
    c.activate('b');
    c.commit(0.66);
    expect(store.saved.get('a')).toBeCloseTo(0.4);
    expect(store.saved.get('b')).toBeCloseTo(0.66);
  });

  it('resizing one workspace never touches another workspace view', () => {
    const c = make();
    const a = fakeView();
    const b = fakeView();
    c.register('a', a);
    c.register('b', b);
    c.activate('a');
    b.setBounds.mockClear();
    b.setVisible.mockClear();
    c.preview(0.3);
    c.commit(0.4);
    c.relayout();
    expect(b.setBounds).not.toHaveBeenCalled();
    expect(b.setVisible).not.toHaveBeenCalled();
  });

  it('clamps to minimum widths and relayouts on window resize', () => {
    const c = make();
    const a = fakeView();
    c.register('a', a);
    c.activate('a');
    c.commit(0.01);
    expect(a.setBounds.mock.calls.at(-1)![0].width).toBeGreaterThanOrEqual(360);
    area = { ...area, width: 2000 };
    c.relayout();
    expect(a.setBounds.mock.calls.at(-1)![0]).toEqual(computeSplitGeometry(area, c.getActiveRatio()).chatgpt);
  });

  it('rejects invalid input', () => {
    const c = make();
    expect(() => c.preview(0.5)).toThrow();
    c.register('a', fakeView());
    c.activate('a');
    expect(() => c.commit(Number.NaN)).toThrow();
    expect(() => c.activate('nope')).toThrow();
  });

  describe('layout presets', () => {
    const chatWidth = (v: ReturnType<typeof fakeView>) => v.setBounds.mock.calls.at(-1)![0].width;
    const usable = () => area.width - 6;

    it('each preset maps to its layout; hidden modes only toggle visibility', () => {
      const c = make();
      const a = fakeView();
      c.register('a', a);
      c.activate('a');
      area = { x: 0, y: 0, width: 2406, height: 900 };
      c.setMode('split-20-80');
      expect(chatWidth(a)).toBe(Math.round(usable() * 0.2));
      c.setMode('split-50-50');
      expect(chatWidth(a)).toBe(Math.round(usable() * 0.5));
      c.setMode('split-80-20');
      expect(chatWidth(a)).toBe(Math.round(usable() * 0.8));
      c.setMode('terminal-hidden');
      expect(a.setBounds.mock.calls.at(-1)![0]).toEqual(area);
      expect(a.setVisible).toHaveBeenLastCalledWith(true);
      a.setBounds.mockClear();
      c.setMode('gpt-hidden');
      expect(a.setVisible).toHaveBeenLastCalledWith(false);
      expect(a.setBounds).not.toHaveBeenCalled();
      c.setMode('split-50-50');
      expect(a.setVisible).toHaveBeenLastCalledWith(true);
      expect(a.webContents.loadURL).not.toHaveBeenCalled();
      expect(a.webContents.reload).not.toHaveBeenCalled();
      expect(a.webContents.close).not.toHaveBeenCalled();
    });

    it('keeps a layout per workspace, across tab switches, restart and window moves', () => {
      let c = make();
      c.register('a', fakeView());
      c.register('b', fakeView());
      c.activate('a');
      c.setMode('split-80-20');
      c.activate('b');
      c.setMode('split-50-50');
      expect(c.activate('a') && c.activeMode).toBe('split-80-20');
      expect(c.activate('b') && c.activeMode).toBe('split-50-50');
      // "restart" and "moved to another window" both mean: a fresh controller registering from the same store.
      c = make();
      c.register('a', fakeView());
      c.register('b', fakeView());
      c.activate('a');
      expect(c.activeMode).toBe('split-80-20');
      c.activate('b');
      expect(c.activeMode).toBe('split-50-50');
    });

    it('drag makes it custom (persisted); a preset click leaves custom again', () => {
      const c = make();
      c.register('a', fakeView());
      c.activate('a');
      c.setMode('split-50-50');
      c.preview(0.4);
      expect(c.activeMode).toBe('custom');
      c.commit(0.45);
      expect(store.modes.get('a')).toBe('custom');
      expect(store.saved.get('a')).toBeCloseTo(0.45);
      c.setMode('split-80-20');
      expect(store.modes.get('a')).toBe('split-80-20');
      expect(store.saved.get('a')).toBeCloseTo(0.45);
    });

    it('presets reflow by ratio on window resize and hidden modes stay hidden', () => {
      const c = make();
      const a = fakeView();
      c.register('a', a);
      c.activate('a');
      c.setMode('split-50-50');
      area = { ...area, width: 1806 };
      c.relayout();
      expect(chatWidth(a)).toBe(900);
      c.setMode('gpt-hidden');
      area = { ...area, width: 1206 };
      a.setVisible.mockClear();
      c.relayout();
      expect(a.setVisible).not.toHaveBeenCalled();
      expect(a.setVisible).not.toHaveBeenCalledWith(true);
    });

    it('relay geometry is only reported while a divider exists', () => {
      const geo = vi.fn();
      const c = new SplitLayoutController(store, () => area, geo);
      c.register('a', fakeView());
      c.activate('a');
      c.setMode('split-50-50');
      expect(geo.mock.calls.at(-1)![0]).not.toBeNull();
      c.setMode('gpt-hidden');
      expect(geo.mock.calls.at(-1)![0]).toBeNull();
      c.setMode('terminal-hidden');
      expect(geo.mock.calls.at(-1)![0]).toBeNull();
    });
  });
});
