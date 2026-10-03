import { describe, expect, it } from 'vitest';
import { shiftFor, targetIndex } from '../components/TabBar';

describe('tab drag geometry', () => {
  const slot = 140;
  it('maps the pointer x offset to a clamped target slot', () => {
    expect(targetIndex(0, 30, slot, 4)).toBe(0);
    expect(targetIndex(0, 90, slot, 4)).toBe(1);
    expect(targetIndex(0, 500, slot, 4)).toBe(3);
    expect(targetIndex(3, -500, slot, 4)).toBe(0);
  });

  it('slides only the tabs between origin and target, toward the gap', () => {
    // Dragging item 0 down to slot 2: items 1 and 2 move up one slot, item 3 stays.
    expect([1, 2, 3].map((i) => shiftFor(i, 0, 2, slot))).toEqual([-slot, -slot, 0]);
    // Dragging item 3 up to slot 1: items 1 and 2 move down, item 0 stays.
    expect([0, 1, 2].map((i) => shiftFor(i, 3, 1, slot))).toEqual([0, slot, slot]);
    expect(shiftFor(1, 2, 2, slot)).toBe(0);
  });
});
