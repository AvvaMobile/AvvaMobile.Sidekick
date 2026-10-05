import type { Rect } from '../domain/layout/splitPane';

/** Fixed chrome of the shell window: the tab strip on top; the split work area is everything below it. */
export const TOPBAR_HEIGHT = 44;

export function workAreaFor(contentWidth: number, contentHeight: number): Rect {
  return {
    x: 0,
    y: TOPBAR_HEIGHT,
    width: Math.max(0, contentWidth),
    height: Math.max(0, contentHeight - TOPBAR_HEIGHT),
  };
}
