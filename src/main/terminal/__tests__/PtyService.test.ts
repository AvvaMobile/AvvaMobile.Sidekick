import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { DevelopmentPaneRegistry } from '../../development/DevelopmentPane';
import { PtyService, type PtyProcess } from '../PtyService';

function fakePty() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const p = {
    written: [] as string[],
    onData: (cb: (d: string) => void) => void (dataCb = cb),
    onExit: (cb: (e: { exitCode: number }) => void) => void (exitCb = cb),
    write: vi.fn((d: string) => void p.written.push(d)),
    resize: vi.fn(),
    kill: vi.fn(),
    emit: (d: string) => dataCb(d),
    exit: () => exitCb({ exitCode: 0 }),
  };
  return p;
}

describe('PtyService', () => {
  it('one shell per Workspace in its own cwd; input/output never cross Workspaces', () => {
    const panes = new DevelopmentPaneRegistry();
    panes.ensure('a');
    panes.ensure('b');
    const spawned: Array<{ cwd: string; p: ReturnType<typeof fakePty> }> = [];
    const svc = new PtyService(
      panes,
      (_shell, _args, opts) => {
        const p = fakePty();
        spawned.push({ cwd: opts.cwd, p });
        return p as unknown as PtyProcess;
      },
      () => ({ SHELL: '/bin/zsh' }),
      () => {},
    );
    const dir = tmpdir();
    svc.start('a', dir);
    svc.start('b', dir);
    svc.start('a', dir); // idempotent: never restarts a live shell
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.cwd).toBe(dir);

    panes.writeUserInput('a', 'ls\r');
    expect(spawned[0]!.p.written).toEqual(['ls\r']);
    expect(spawned[1]!.p.written).toEqual([]);

    spawned[1]!.p.emit('b-output');
    expect(panes.snapshot('b')).toBe('b-output');
    expect(panes.snapshot('a')).toBe('');
  });

  it('reports a missing working directory instead of starting elsewhere', () => {
    const panes = new DevelopmentPaneRegistry();
    panes.ensure('a');
    const factory = vi.fn();
    const onState = vi.fn();
    new PtyService(panes, factory, () => ({}), onState).start('a', '/definitely/not/here');
    expect(factory).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith('a', expect.objectContaining({ running: false, error: expect.stringContaining('not found') }));
  });

  it('shell exit is reported and restart creates a new shell for that Workspace only', () => {
    const panes = new DevelopmentPaneRegistry();
    panes.ensure('a');
    const ps: Array<ReturnType<typeof fakePty>> = [];
    const onState = vi.fn();
    const svc = new PtyService(
      panes,
      () => {
        const p = fakePty();
        ps.push(p);
        return p as unknown as PtyProcess;
      },
      () => ({}),
      onState,
    );
    svc.start('a', tmpdir());
    ps[0]!.exit();
    expect(onState).toHaveBeenLastCalledWith('a', { running: false, error: null });
    svc.restart('a');
    expect(ps).toHaveLength(2);
  });

  it('relaunch replaces the process; the old one output and exit are ignored', () => {
    const panes = new DevelopmentPaneRegistry();
    panes.ensure('a');
    const spawned: Array<ReturnType<typeof fakePty>> = [];
    const states: boolean[] = [];
    const svc = new PtyService(
      panes,
      () => {
        const p = fakePty();
        spawned.push(p);
        return p as unknown as PtyProcess;
      },
      () => ({ SHELL: '/bin/zsh' }),
      (_id, s) => void states.push(s.running),
    );
    svc.start('a', tmpdir());
    svc.relaunch('a');
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.kill).toHaveBeenCalled();
    spawned[0]!.exit();
    expect(svc.isRunning('a')).toBe(true);
    expect(states).toEqual([true, true]);
  });

  it('stop force-kills a process that is still alive after the grace period, not one that exited', () => {
    vi.useFakeTimers();
    try {
      const panes = new DevelopmentPaneRegistry();
      panes.ensure('a');
      panes.ensure('b');
      const spawned: Array<ReturnType<typeof fakePty>> = [];
      const svc = new PtyService(
        panes,
        () => {
          const p = fakePty();
          spawned.push(p);
          return p as unknown as PtyProcess;
        },
        () => ({ SHELL: '/bin/zsh' }),
        () => {},
      );
      svc.start('a', tmpdir());
      svc.start('b', tmpdir());
      svc.stopAll();
      spawned[1]!.exit();
      vi.advanceTimersByTime(1_499);
      expect(spawned[0]!.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(spawned[0]!.kill).toHaveBeenLastCalledWith('SIGKILL');
      expect(spawned[1]!.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
