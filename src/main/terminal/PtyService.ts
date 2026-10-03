import { existsSync, statSync } from 'node:fs';
import type { DevelopmentPaneRegistry } from '../development/DevelopmentPane';

/** Minimal node-pty surface (fakeable in tests). */
export interface PtyProcess {
  onData(cb: (data: string) => void): { dispose(): void } | void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** `args` may be a single verbatim command line (Windows only, as node-pty accepts). */
export type PtyFactory = (shell: string, args: string[] | string, opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyProcess;

/** What to run in a Workspace terminal instead of the login shell (e.g. interactive Claude). */
export interface PtyCommand {
  file: string;
  args: string[] | string;
  env: NodeJS.ProcessEnv;
}

export type PtyCommandResolver = (workspaceId: string, opts: { fresh: boolean }) => PtyCommand | { error: string };

interface Entry {
  exitListeners: Set<() => void>;
  pty: PtyProcess | null;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * One manual interactive shell per Workspace (D020). Lifecycle is independent from managed Claude
 * tasks: nothing here reads task state and the orchestrator never reads terminal output.
 * Workspace switching never touches these processes.
 */
/** A process that ignores the normal kill (SIGHUP) is force-killed this long after it. */
const KILL_GRACE_MS = 1_500;

export class PtyService {
  private readonly entries = new Map<string, Entry>();
  private readonly exited = new WeakSet<PtyProcess>();

  constructor(
    private readonly panes: DevelopmentPaneRegistry,
    private readonly factory: PtyFactory,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly onState: (workspaceId: string, state: { running: boolean; error: string | null }) => void,
    private readonly command?: PtyCommandResolver,
  ) {}

  isRunning(workspaceId: string): boolean {
    return !!this.entries.get(workspaceId)?.pty;
  }

  write(workspaceId: string, data: string): void {
    this.entries.get(workspaceId)?.pty?.write(data);
  }

  /** Called once when the terminal process of this Workspace exits. Returns an unsubscribe function. */
  onExit(workspaceId: string, cb: () => void): () => void {
    const e = this.entries.get(workspaceId);
    if (!e) return () => {};
    e.exitListeners.add(cb);
    return () => e.exitListeners.delete(cb);
  }

  start(workspaceId: string, cwd: string, opts: { fresh?: boolean } = {}): void {
    const existing = this.entries.get(workspaceId);
    if (existing?.pty) return;
    const entry: Entry = existing ?? { pty: null, cwd, cols: 100, rows: 30, exitListeners: new Set() };
    entry.cwd = cwd;
    this.entries.set(workspaceId, entry);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      this.onState(workspaceId, { running: false, error: `Working directory not found: ${cwd}` });
      return;
    }
    let file: string;
    let args: string[] | string;
    let env: NodeJS.ProcessEnv;
    if (this.command) {
      const c = this.command(workspaceId, { fresh: opts.fresh ?? false });
      if ('error' in c) {
        this.onState(workspaceId, { running: false, error: c.error });
        return;
      }
      ({ file, args, env } = c);
    } else {
      env = { ...this.env() };
      if (process.platform === 'win32') {
        file = env.COMSPEC || env.ComSpec || 'powershell.exe';
        args = [];
      } else {
        file = env.SHELL || '/bin/zsh';
        args = ['-l'];
      }
    }
    env = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AvvaMobileSidekick' };
    let pty: PtyProcess;
    try {
      pty = this.factory(file, args, { cwd, cols: entry.cols, rows: entry.rows, env });
    } catch (err) {
      this.onState(workspaceId, { running: false, error: `Could not start ${this.command ? 'Claude' : 'shell'}: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    entry.pty = pty;
    this.panes.attachPty(workspaceId, pty);
    pty.onData((d) => {
      if (this.entries.get(workspaceId)?.pty === pty) this.panes.writeOutput(workspaceId, 'pty', d);
    });
    pty.onExit(() => {
      this.exited.add(pty);
      const e = this.entries.get(workspaceId);
      if (e?.pty !== pty) return;
      e.pty = null;
      for (const l of [...e.exitListeners]) l();
      if (this.panes.has(workspaceId)) {
        this.panes.attachPty(workspaceId, null);
        this.panes.writeOutput(workspaceId, 'pty', `\r\n\x1b[2m[${this.command ? 'Claude' : 'shell'} exited — use Restart]\x1b[0m\r\n`);
      }
      this.onState(workspaceId, { running: false, error: null });
    });
    this.onState(workspaceId, { running: true, error: null });
  }

  restart(workspaceId: string): void {
    const e = this.entries.get(workspaceId);
    if (!e) return;
    if (e.pty) return;
    this.start(workspaceId, e.cwd, { fresh: true });
  }

  /** Replaces a running process by a new one (resuming its session): the old process's output and exit are ignored from now on. */
  relaunch(workspaceId: string): void {
    const e = this.entries.get(workspaceId);
    if (!e) return;
    const old = e.pty;
    e.pty = null;
    if (old) this.kill(old);
    this.notifyEnded(e, old);
    this.start(workspaceId, e.cwd, { fresh: false });
  }

  /** Replaces the process by a fresh one in another working directory (the project folder changed). */
  restartIn(workspaceId: string, cwd: string): void {
    const e = this.entries.get(workspaceId);
    if (!e) return;
    const old = e.pty;
    e.pty = null;
    if (old) this.kill(old);
    this.notifyEnded(e, old);
    e.cwd = cwd;
    this.start(workspaceId, cwd, { fresh: true });
  }

  /** A replaced process never reports its own exit (its output and exit are ignored): tell the listeners it ended. */
  private notifyEnded(e: Entry, old: PtyProcess | null): void {
    if (old) for (const l of [...e.exitListeners]) l();
  }

  resize(workspaceId: string, cols: number, rows: number): void {
    const e = this.entries.get(workspaceId);
    if (!e) return;
    e.cols = cols;
    e.rows = rows;
    try {
      e.pty?.resize(cols, rows);
    } catch {
      // process may be exiting
    }
  }

  stop(workspaceId: string): void {
    const e = this.entries.get(workspaceId);
    this.entries.delete(workspaceId);
    if (e?.pty) this.kill(e.pty);
  }

  /** Normal kill, then SIGKILL if the process is still alive after a grace period (slow quit otherwise). */
  private kill(pty: PtyProcess): void {
    try {
      pty.kill();
    } catch {
      return; // already gone
    }
    setTimeout(() => {
      if (this.exited.has(pty)) return;
      try {
        pty.kill('SIGKILL');
      } catch {
        // gone, or signals unsupported (Windows)
      }
    }, KILL_GRACE_MS);
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.stop(id);
  }
}
