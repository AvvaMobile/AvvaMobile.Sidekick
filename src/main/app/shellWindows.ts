import type { ShellState } from '../../shared/state';

/**
 * Pure helpers for multiple shell windows. Each open Workspace tab lives in exactly one window;
 * a window's renderer only ever sees its own tabs (the Projects list is the same everywhere).
 */

/** The full shell state narrowed to one window's tabs and that window's active tab. */
export function stateForWindow(state: ShellState, inWindow: (id: string) => boolean, activeWorkspaceId: string | null): ShellState {
  return { ...state, workspaces: state.workspaces.filter((w) => inWindow(w.id)), activeWorkspaceId };
}

/** The tab a window shows after its tabs changed: the current one if it is still there, else its first tab. */
export function nextActiveTab(orderedIds: readonly string[], inWindow: (id: string) => boolean, current: string | null): string | null {
  if (current && inWindow(current) && orderedIds.includes(current)) return current;
  return orderedIds.find(inWindow) ?? null;
}

/**
 * Applies one window's reordered tabs to the global tab order: that window's slots get its new order,
 * every other window's tabs keep their positions. Null unless `windowOrder` is exactly the window's tabs.
 */
export function mergeWindowOrder(globalOrder: readonly string[], inWindow: (id: string) => boolean, windowOrder: readonly string[]): string[] | null {
  const own = globalOrder.filter(inWindow);
  if (own.length !== windowOrder.length || new Set(windowOrder).size !== windowOrder.length || !windowOrder.every((id) => own.includes(id))) return null;
  let i = 0;
  return globalOrder.map((id) => (inWindow(id) ? windowOrder[i++]! : id));
}

const pageKey = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    return decodeURIComponent(`${u.protocol}//${u.host}${u.pathname}`);
  } catch {
    return null;
  }
};

/** Whether `url` is the page `expected` (query and fragment ignored; percent-encoding normalized). */
export function isSamePage(url: string, expected: string): boolean {
  const k = pageKey(url);
  return k !== null && k === pageKey(expected);
}
