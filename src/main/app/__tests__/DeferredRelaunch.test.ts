import { describe, expect, it, vi } from 'vitest';
import { DeferredRelaunch } from '../DeferredRelaunch';

function make(working = false, running = true) {
  const st = { working, running };
  const relaunch = vi.fn();
  const d = new DeferredRelaunch({ working: () => st.working, isRunning: () => st.running, relaunch });
  return { d, st, relaunch };
}

describe('DeferredRelaunch (model / effort picked during a running turn)', () => {
  it('relaunches at once when nothing is running', () => {
    const { d, relaunch } = make();
    d.request('a', 'sonnet');
    expect(relaunch).toHaveBeenCalledWith('a', 'sonnet');
  });

  it('while a turn runs the running process is left alone; the next turn gets the new model', () => {
    const { d, st, relaunch } = make(true);
    d.request('a', 'sonnet');
    d.settled('a'); // still running
    expect(relaunch).not.toHaveBeenCalled();
    expect(d.has('a')).toBe(true);
    st.working = false; // the turn ended
    d.settled('a');
    expect(relaunch).toHaveBeenCalledOnce();
    d.settled('a');
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('the latest pick wins and Workspaces are independent', () => {
    const { d, st, relaunch } = make(true);
    d.request('a', 'sonnet');
    d.request('a', 'opus');
    d.request('b', 'fable');
    st.working = false;
    d.settled('a');
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledWith('a', 'opus');
    expect(d.has('b')).toBe(true);
  });

  it('nothing is relaunched for a terminal that is no longer running or a forgotten Workspace', () => {
    const { d, st, relaunch } = make(true, false);
    d.request('a', 'sonnet');
    st.working = false;
    d.settled('a');
    expect(relaunch).not.toHaveBeenCalled();
    d.request('b', 'opus');
    d.forget('b');
    d.settled('b');
    expect(relaunch).not.toHaveBeenCalled();
  });
});
