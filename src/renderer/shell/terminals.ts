import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { api } from './api';

/**
 * One xterm.js instance per Workspace, created once and never recreated on Workspace switch.
 * Each instance only ever receives its own Workspace's PTY output and only writes to its own PTY.
 */
interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  ready: boolean;
}

const instances = new Map<string, Instance>();

export function ensureTerminal(workspaceId: string, host: HTMLElement): Instance {
  let inst = instances.get(workspaceId);
  if (inst) {
    if (inst.el.parentElement !== host) host.appendChild(inst.el);
    return inst;
  }
  const el = document.createElement('div');
  el.className = 'xterm-host';
  el.dataset.workspaceId = workspaceId;
  host.appendChild(el);
  const term = new Terminal({
    fontFamily: "SF Mono, Menlo, 'Cascadia Mono', Consolas, ui-monospace, monospace",
    // Matches the user's Terminal.app profile size (Monaco 16).
    fontSize: 16,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    theme: { background: '#121417', foreground: '#d7dae0', cursor: '#d97757', selectionBackground: '#3a4150' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((d) => api.terminalInput(workspaceId, d));
  term.onResize(({ cols, rows }) => api.terminalResize(workspaceId, cols, rows));
  inst = { term, fit, el, ready: false };
  instances.set(workspaceId, inst);
  const created = inst;
  void api.terminalSnapshot(workspaceId).then((snap) => {
    if (snap) created.term.write(snap);
    created.ready = true;
  });
  return inst;
}

export function terminalData(workspaceId: string, data: string): void {
  const inst = instances.get(workspaceId);
  // Main->renderer IPC is ordered: anything received before the snapshot reply is already in the snapshot.
  if (inst?.ready) inst.term.write(data);
}

export function showTerminal(workspaceId: string | null, visible: boolean): void {
  for (const [id, inst] of instances) {
    const show = visible && id === workspaceId;
    inst.el.style.display = show ? 'block' : 'none';
    if (show) {
      requestAnimationFrame(() => {
        try {
          inst.fit.fit();
        } catch {
          // not measurable yet
        }
        inst.term.focus();
      });
    }
  }
}

export function fitTerminal(workspaceId: string | null): void {
  const inst = workspaceId ? instances.get(workspaceId) : undefined;
  if (inst && inst.el.style.display !== 'none') {
    try {
      inst.fit.fit();
    } catch {
      // ignore
    }
  }
}

export function disposeTerminal(workspaceId: string): void {
  const inst = instances.get(workspaceId);
  instances.delete(workspaceId);
  inst?.term.dispose();
  inst?.el.remove();
}
