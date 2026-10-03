/**
 * Per-Workspace development pane (Claude/terminal side) state.
 *
 * The pane is NOT an application debug console (D022). Its content changes only through the
 * legitimate sources below; there is deliberately no generic `log(string)` entry point, and
 * ChatGPT-side modules (adapter, view, navigation/permission policy, diagnostics) never import this.
 *
 *   user keystrokes -> writeUserInput()     -> that Workspace's PTY stdin only
 *   PTY output      -> writeOutput('pty')   -> terminal buffer
 *
 * The visible pane is one terminal per Workspace running the interactive Claude (D026, D033).
 * Nothing here ever writes to the PTY's stdin except writeUserInput.
 */
export type DevPaneOutputSource = 'pty';

const DEFAULT_BUFFER_LIMIT = 2_000_000;

export interface PtyInput {
  write(data: string): void;
}

export interface DevPaneEvent {
  workspaceId: string;
  data: string;
}

interface PaneState {
  buffer: string;
  pty: PtyInput | null;
}

export class DevelopmentPaneRegistry {
  private readonly panes = new Map<string, PaneState>();
  private readonly listeners = new Set<(e: DevPaneEvent) => void>();

  constructor(private readonly bufferLimit = DEFAULT_BUFFER_LIMIT) {}

  ensure(workspaceId: string): void {
    if (!workspaceId) throw new Error('workspaceId required');
    if (!this.panes.has(workspaceId)) this.panes.set(workspaceId, { buffer: '', pty: null });
  }

  has(workspaceId: string): boolean {
    return this.panes.has(workspaceId);
  }

  attachPty(workspaceId: string, pty: PtyInput | null): void {
    this.pane(workspaceId).pty = pty;
  }

  /** Explicit keystrokes typed by the user into this Workspace's manual terminal. */
  writeUserInput(workspaceId: string, data: string): void {
    this.pane(workspaceId).pty?.write(data);
  }

  writeOutput(workspaceId: string, source: DevPaneOutputSource, data: string): void {
    if (source !== 'pty') throw new Error(`illegal development pane source: ${String(source)}`);
    const pane = this.pane(workspaceId);
    const next = pane.buffer + data;
    pane.buffer = next.length > this.bufferLimit ? next.slice(next.length - this.bufferLimit) : next;
    this.emit({ workspaceId, data });
  }

  /** Terminal buffer (PTY output). */
  snapshot(workspaceId: string): string {
    return this.pane(workspaceId).buffer;
  }

  onEvent(listener: (e: DevPaneEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(workspaceId: string): void {
    this.panes.delete(workspaceId);
  }

  private emit(e: DevPaneEvent): void {
    for (const l of this.listeners) l(e);
  }

  private pane(workspaceId: string): PaneState {
    const p = this.panes.get(workspaceId);
    if (!p) throw new Error(`no development pane for workspace ${workspaceId}`);
    return p;
  }
}
