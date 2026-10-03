import { describe, expect, it } from 'vitest';
import type { ShellState, WorkspaceView } from '../../../shared/state';
import { isSamePage, mergeWindowOrder, nextActiveTab, stateForWindow } from '../shellWindows';

const inSet = (...ids: string[]) => (id: string) => ids.includes(id);

describe('stateForWindow', () => {
  it('keeps only the window’s tabs, its active tab and the shared project list', () => {
    const state = {
      workspaces: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as unknown as WorkspaceView[],
      projects: [{ id: 'a', name: 'A', projectPath: '/a', open: true }],
      activeWorkspaceId: 'a',
      debugMode: true,
    } satisfies ShellState;
    const s = stateForWindow(state, inSet('b', 'c'), 'c');
    expect(s.workspaces.map((w) => w.id)).toEqual(['b', 'c']);
    expect(s.activeWorkspaceId).toBe('c');
    expect(s.projects).toBe(state.projects);
    expect(s.debugMode).toBe(true);
  });
});

describe('nextActiveTab', () => {
  it('keeps the current tab while it is still in the window', () => {
    expect(nextActiveTab(['a', 'b', 'c'], inSet('b', 'c'), 'c')).toBe('c');
  });
  it('falls back to the window’s first tab', () => {
    expect(nextActiveTab(['a', 'b', 'c'], inSet('b', 'c'), 'a')).toBe('b');
    expect(nextActiveTab(['a', 'b', 'c'], inSet('c'), null)).toBe('c');
  });
  it('is null when the window has no tabs left (start page)', () => {
    expect(nextActiveTab(['a'], inSet(), 'a')).toBeNull();
  });
});

describe('mergeWindowOrder', () => {
  it('reorders the window’s slots and leaves other windows’ tabs in place', () => {
    expect(mergeWindowOrder(['a', 'b', 'c', 'd'], inSet('b', 'd'), ['d', 'b'])).toEqual(['a', 'd', 'c', 'b']);
  });
  it('works for a window holding every tab', () => {
    expect(mergeWindowOrder(['a', 'b'], () => true, ['b', 'a'])).toEqual(['b', 'a']);
  });
  it('rejects orders that are not exactly the window’s tabs', () => {
    expect(mergeWindowOrder(['a', 'b', 'c'], inSet('b', 'c'), ['b'])).toBeNull();
    expect(mergeWindowOrder(['a', 'b', 'c'], inSet('b', 'c'), ['b', 'a'])).toBeNull();
    expect(mergeWindowOrder(['a', 'b', 'c'], inSet('b', 'c'), ['b', 'b'])).toBeNull();
  });
});

describe('isSamePage (shell IPC sender check)', () => {
  const shell = 'file:///Applications/Avva%20Mobile%20Sidekick.app/Contents/Resources/app.asar/out/renderer/shell/index.html';
  it('accepts only the bundled shell page', () => {
    expect(isSamePage(shell, shell)).toBe(true);
    expect(isSamePage(`${shell}#x`, shell)).toBe(true);
    expect(isSamePage('file:///Applications/Avva Mobile Sidekick.app/Contents/Resources/app.asar/out/renderer/shell/index.html', shell)).toBe(true);
    expect(isSamePage('file:///tmp/evil.html', shell)).toBe(false);
    expect(isSamePage('https://chatgpt.com/', shell)).toBe(false);
    expect(isSamePage('http://localhost:5173/shell/index.html', 'http://localhost:5173/shell/index.html')).toBe(true);
    expect(isSamePage('http://localhost:5174/shell/index.html', 'http://localhost:5173/shell/index.html')).toBe(false);
    expect(isSamePage('', shell)).toBe(false);
  });
});
