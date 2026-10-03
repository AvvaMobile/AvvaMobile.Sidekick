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

/** Overlay holding the round relay buttons: centred on the splitter, vertically centred in the work area. */
export const RELAY_WIDTH = 112;
const RELAY_HEIGHT = 200;

export function relayBounds(splitter: Rect): Rect {
  return {
    x: Math.round(splitter.x + splitter.width / 2 - RELAY_WIDTH / 2),
    y: Math.round(splitter.y + Math.max(0, (splitter.height - RELAY_HEIGHT) / 2)),
    width: RELAY_WIDTH,
    height: RELAY_HEIGHT,
  };
}
