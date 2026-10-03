/**
 * Model / effort picked while a Claude turn is running apply to the NEXT turn: the choice is stored at
 * once, but the terminal's Claude is relaunched (same session) only when nothing is running any more,
 * never underneath a running turn.
 */
export class DeferredRelaunch {
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly state: {
      /** A managed task or a terminal turn is running in this Workspace. */
      working(workspaceId: string): boolean;
      isRunning(workspaceId: string): boolean;
      relaunch(workspaceId: string, why: string): void;
    },
  ) {}

  /** Relaunch now when idle, otherwise as soon as `settled` is called. */
  request(workspaceId: string, why: string): void {
    this.pending.set(workspaceId, why);
    this.settled(workspaceId);
  }

  /** A task or turn ended (or may have ended): performs a waiting relaunch if nothing is running. */
  settled(workspaceId: string): void {
    const why = this.pending.get(workspaceId);
    if (!why || this.state.working(workspaceId)) return;
    this.pending.delete(workspaceId);
    if (this.state.isRunning(workspaceId)) this.state.relaunch(workspaceId, why);
  }

  has(workspaceId: string): boolean {
    return this.pending.has(workspaceId);
  }

  forget(workspaceId: string): void {
    this.pending.delete(workspaceId);
  }
}
