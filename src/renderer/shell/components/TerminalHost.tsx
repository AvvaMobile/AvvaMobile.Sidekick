import { useEffect, useRef } from 'react';
import { ensureTerminal, fitTerminal, showTerminal } from '../terminals';

interface Props {
  workspaceIds: string[];
  activeId: string | null;
  visible: boolean;
  running: boolean;
  error: string | null;
  onRestart(): void;
}

/** Hosts every Workspace's xterm instance; only the active one is shown. Never recreated on switch. */
export function TerminalHost({ workspaceIds, activeId, visible, running, error, onRestart }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    for (const id of workspaceIds) ensureTerminal(id, host.current);
    showTerminal(activeId, visible);
  }, [workspaceIds.join(','), activeId, visible]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitTerminal(activeId));
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId]);

  return (
    <div className="terminal-wrap" style={{ display: visible ? 'flex' : 'none' }}>
      {(!running || error) && (
        <div className="terminal-banner">
          <span>{error ?? 'Shell exited.'}</span>
          {!error && (
            <button className="btn small" onClick={onRestart}>
              Restart shell
            </button>
          )}
        </div>
      )}
      <div className="terminal-host" ref={host} />
    </div>
  );
}
