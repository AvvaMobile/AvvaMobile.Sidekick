import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPLIT_RATIO, computeSplitGeometry, type Rect } from '../../../domain/layout/splitPane';
import { SplitLayoutController, type SplitRatioStore } from '../SplitLayoutController';

/** In-memory ratio store (the shell persists through AppStateStore). */
function memoryStore(): SplitRatioStore & { saved: Map<string, number> } {
  const saved = new Map<string, number>();
  return { saved, getSplitRatio: (id) => saved.get(id) ?? DEFAULT_SPLIT_RATIO, setSplitRatio: (id, r) => void saved.set(id, r) };
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
});
