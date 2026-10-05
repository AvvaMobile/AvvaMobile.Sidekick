import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPLIT_RATIO, computeSplitGeometry, type Rect } from '../../../domain/layout/splitPane';
import { STATUS_BAR_HEIGHT, type ViewMode } from '../../../domain/layout/viewMode';
import { SplitLayoutController, type SplitRatioStore } from '../SplitLayoutController';

/** In-memory ratio store (the shell persists through AppStateStore). */
function memoryStore(): SplitRatioStore & { saved: Map<string, number>; modes: Map<string, ViewMode> } {
  const saved = new Map<string, number>();
  const modes = new Map<string, ViewMode>();
  return {
    saved,
    modes,
    getSplitRatio: (id) => saved.get(id) ?? DEFAULT_SPLIT_RATIO,
    setSplitRatio: (id, r) => void saved.set(id, r),
    getViewMode: (id) => modes.get(id) ?? 'split',
    setViewMode: (id, m) => void modes.set(id, m),
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

  describe('views (ChatGPT Focus / Split / Claude Focus)', () => {
    const noRuntimeTouch = (v: ReturnType<typeof fakeView>) => {
      expect(v.webContents.loadURL).not.toHaveBeenCalled();
      expect(v.webContents.reload).not.toHaveBeenCalled();
      expect(v.webContents.close).not.toHaveBeenCalled();
    };

    it('Split shows ChatGPT at the Workspace ratio', () => {
      const c = make();
      const a = fakeView();
      c.register('a', a);
      c.activate('a');
      expect(c.activeViewMode).toBe('split');
      expect(a.setBounds.mock.calls.at(-1)![0]).toEqual(computeSplitGeometry(area, DEFAULT_SPLIT_RATIO).chatgpt);
      expect(a.setVisible).toHaveBeenLastCalledWith(true);
    });

    it('ChatGPT Focus fills the area above the status bar; Claude Focus hides ChatGPT without touching its bounds', () => {
      const c = make();
      const a = fakeView();
      c.register('a', a);
      c.activate('a');
      c.setViewMode('chatgpt-focus');
      expect(a.setBounds.mock.calls.at(-1)![0]).toEqual({ ...area, height: area.height - STATUS_BAR_HEIGHT });
      expect(a.setVisible).toHaveBeenLastCalledWith(true);
      a.setBounds.mockClear();
      c.setViewMode('claude-focus');
      expect(a.setVisible).toHaveBeenLastCalledWith(false);
      c.relayout();
      expect(a.setBounds).not.toHaveBeenCalled();
      c.setViewMode('split');
      expect(a.setVisible).toHaveBeenLastCalledWith(true);
      noRuntimeTouch(a);
    });

    it('Split -> ChatGPT Focus -> Claude Focus -> Split restores the manual ratio and never rewrites it', () => {
      area = { ...area, width: 2400 };
      const c = make();
      const a = fakeView();
      c.register('a', a);
      c.activate('a');
      c.commit(0.72);
      const saved = store.saved.get('a');
      c.setViewMode('chatgpt-focus');
      c.preview(0.3); // no divider outside Split: ignored
      c.commit(0.3);
      c.setViewMode('claude-focus');
      c.commit(0.3);
      c.setViewMode('split');
      expect(store.saved.get('a')).toBe(saved);
      expect(c.getActiveRatio()).toBeCloseTo(0.72);
      expect(a.setBounds.mock.calls.at(-1)![0]).toEqual(computeSplitGeometry(area, 0.72).chatgpt);
      noRuntimeTouch(a);
    });

    it('each Workspace keeps its own view and ratio; switching tabs restores them', () => {
      area = { ...area, width: 2400 };
      const c = make();
      const a = fakeView();
      const b = fakeView();
      const d = fakeView();
      c.register('a', a);
      c.register('b', b);
      c.register('c', d);
      c.activate('a');
      c.setViewMode('chatgpt-focus');
      c.activate('b');
      c.setViewMode('claude-focus');
      c.activate('c');
      c.commit(0.4);
      c.activate('a');
      expect(c.activeViewMode).toBe('chatgpt-focus');
      expect(a.setVisible).toHaveBeenLastCalledWith(true);
      expect(b.setVisible).toHaveBeenLastCalledWith(false);
      c.activate('b');
      expect(c.activeViewMode).toBe('claude-focus');
      expect(b.setVisible).toHaveBeenLastCalledWith(false); // its ChatGPT is hidden in Claude Focus
      c.activate('c');
      expect(c.getActiveRatio()).toBeCloseTo(0.4);
      expect(store.modes.get('a')).toBe('chatgpt-focus');
      expect(store.modes.get('b')).toBe('claude-focus');
      [a, b, d].forEach(noRuntimeTouch);
    });

    it('the views are restored from the store on register (restart)', () => {
      store.modes.set('a', 'claude-focus');
      const c = make();
      const a = fakeView();
      c.register('a', a);
      c.activate('a');
      expect(c.activeViewMode).toBe('claude-focus');
      expect(a.setVisible).toHaveBeenLastCalledWith(false);
    });

    it('the relay buttons only exist on the Split divider', () => {
      const seen: unknown[] = [];
      const c = new SplitLayoutController(store, () => area, (g) => seen.push(g));
      c.register('a', fakeView());
      c.activate('a');
      expect(seen.at(-1)).not.toBeNull();
      c.setViewMode('chatgpt-focus');
      expect(seen.at(-1)).toBeNull();
      c.setViewMode('claude-focus');
      expect(seen.at(-1)).toBeNull();
      c.setViewMode('split');
      expect(seen.at(-1)).not.toBeNull();
    });

    it('rejects an unknown view', () => {
      const c = make();
      c.register('a', fakeView());
      c.activate('a');
      expect(() => c.setViewMode('grid' as never)).toThrow();
      expect(() => c.setViewMode('overview' as never)).toThrow();
    });
  });
});
