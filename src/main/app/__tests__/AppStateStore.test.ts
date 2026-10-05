import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPLIT_RATIO } from '../../../domain/layout/splitPane';
import { newTask } from '../../../domain/task/task';
import type { WorkspaceRecord } from '../../../domain/workspace/workspace';
import { AppStateStore } from '../AppStateStore';

const ws = (id: string): WorkspaceRecord => ({
  id,
  name: id,
  projectPath: `/tmp/${id}`,
  createdAt: '',
  updatedAt: '',
  lastOpenedAt: null,
  sidebarColor: '#000',
  sidebarOrder: 0,
  chatConversationUrl: null,
  claudeSessionId: null,
  uiState: { splitRatio: DEFAULT_SPLIT_RATIO },
  lastTaskId: null,
});

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ws-state-')), 'state.json');

describe('AppStateStore', () => {
  it('persists workspaces, active selection and per-Workspace split ratios', () => {
    const file = tmpFile();
    const s = new AppStateStore(file, 0);
    s.addWorkspace(ws('a'));
    s.addWorkspace(ws('b'));
    s.setSplitRatio('a', 0.35);
    s.setSplitRatio('b', 0.7);
    s.setActiveWorkspace('b');
    const r = new AppStateStore(file, 0);
    expect(r.getSplitRatio('a')).toBe(0.35);
    expect(r.getSplitRatio('b')).toBe(0.7);
    expect(r.get().activeWorkspaceId).toBe('b');
  });

  it('persists layout mode per Workspace; records without one migrate to custom keeping their ratio', () => {
    const file = tmpFile();
    const s = new AppStateStore(file, 0);
    s.addWorkspace(ws('a'));
    s.addWorkspace(ws('b'));
    s.setSplitRatio('a', 0.37);
    s.setLayoutMode('b', 'split-80-20');
    const r = new AppStateStore(file, 0);
    expect(r.getLayoutMode('a')).toBe('custom');
    expect(r.getSplitRatio('a')).toBe(0.37);
    expect(r.getLayoutMode('b')).toBe('split-80-20');
    s.setLayoutMode('a', 'bogus' as never);
    expect(new AppStateStore(file, 0).getLayoutMode('a')).toBe('custom');
  });

  it('marks running tasks interrupted after a restart and keeps review packets', () => {
    const file = tmpFile();
    const s = new AppStateStore(file, 0);
    s.addWorkspace(ws('a'));
    const t = newTask({ id: 't1', workspaceId: 'a', prompt: 'p', sourceConversationUrl: null, sourceAssistantMessageId: null, claudeSessionIdBefore: null, now: '' });
    t.status = 'running';
    s.putTask(t);
    s.putReviewPacket({ id: 'p1', taskId: 't0', workspaceId: 'a', createdAt: '', body: 'b', deliveryStatus: 'pending', deliveryAttempts: 0, lastDeliveryError: null });
    const r = new AppStateStore(file, 0);
    expect(r.task('t1')).toMatchObject({ status: 'interrupted', outcome: 'interrupted' });
    expect(r.reviewPacket('p1')?.deliveryStatus).toBe('pending');
  });

  it('persists a drag-and-drop sidebar order and rejects invalid orders', () => {
    const file = tmpFile();
    const s = new AppStateStore(file, 0);
    for (const id of ['a', 'b', 'c']) s.addWorkspace(ws(id));
    expect(s.reorderWorkspaces(['c', 'a', 'b'])).toBe(true);
    expect(s.reorderWorkspaces(['c', 'a'])).toBe(false);
    const order = (st: AppStateStore) => [...st.get().workspaces].sort((x, y) => x.sidebarOrder - y.sidebarOrder).map((w) => w.id);
    expect(order(new AppStateStore(file, 0))).toEqual(['c', 'a', 'b']);
  });

  it('reorders only open tabs; closed Workspaces keep their record and sort after them', () => {
    const file = tmpFile();
    const s = new AppStateStore(file, 0);
    for (const id of ['a', 'b', 'c']) s.addWorkspace(ws(id));
    s.updateWorkspace('b', { open: false });
    expect(s.reorderWorkspaces(['c', 'a'])).toBe(true);
    expect(s.reorderWorkspaces(['c', 'a', 'b'])).toBe(false);
    const order = [...new AppStateStore(file, 0).get().workspaces].sort((x, y) => x.sidebarOrder - y.sidebarOrder).map((w) => w.id);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('removing a Workspace removes only its data', () => {
    const s = new AppStateStore(tmpFile(), 0);
    s.addWorkspace(ws('a'));
    s.addWorkspace(ws('b'));
    s.putTask(newTask({ id: 'ta', workspaceId: 'a', prompt: 'p', sourceConversationUrl: null, sourceAssistantMessageId: null, claudeSessionIdBefore: null, now: '' }));
    s.putTask(newTask({ id: 'tb', workspaceId: 'b', prompt: 'p', sourceConversationUrl: null, sourceAssistantMessageId: null, claudeSessionIdBefore: null, now: '' }));
    s.removeWorkspace('a');
    expect(s.get().workspaces.map((w) => w.id)).toEqual(['b']);
    expect(s.get().tasks.map((t) => t.id)).toEqual(['tb']);
  });

  it('recovers from a corrupt file and keeps a copy', () => {
    const file = tmpFile();
    writeFileSync(file, '{oops');
    const s = new AppStateStore(file, 0);
    expect(s.get().workspaces).toEqual([]);
    expect(readdirSync(join(file, '..')).some((f) => f.includes('corrupt'))).toBe(true);
  });
  it('auto-send preference defaults on, persists, and older files without preferences read as on', () => {
    const file = tmpFile();
    const s = new AppStateStore(file, 0);
    expect(s.preferences().autoSendOnRequest).toBe(true);
    s.setPreferences({ autoSendOnRequest: false });
    expect(new AppStateStore(file, 0).preferences().autoSendOnRequest).toBe(false);
    const old = tmpFile();
    writeFileSync(old, JSON.stringify({ schemaVersion: 1, workspaces: [], tasks: [], reviewPackets: [], activeWorkspaceId: null }));
    expect(new AppStateStore(old, 0).preferences().autoSendOnRequest).toBe(true);
  });

  it('a failed save is logged and retried later instead of throwing', () => {
    vi.useFakeTimers();
    try {
      const root = mkdtempSync(join(tmpdir(), 'ws-state-'));
      const blocker = join(root, 'blocked');
      writeFileSync(blocker, 'not a directory');
      const file = join(blocker, 'state.json');
      const logs: string[] = [];
      const s = new AppStateStore(file, 10, (l) => logs.push(l), 1_000);
      s.addWorkspace(ws('a'));
      expect(() => vi.advanceTimersByTime(10)).not.toThrow();
      expect(logs).toHaveLength(1);
      vi.advanceTimersByTime(500);
      expect(logs).toHaveLength(1); // no tight loop
      rmSync(blocker);
      vi.advanceTimersByTime(500);
      expect(existsSync(file)).toBe(true);
      expect(() => s.flush()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
