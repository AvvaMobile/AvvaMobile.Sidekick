import { useState } from 'react';
import { EFFORT_CHOICES, EFFORT_LABELS, isEffortChoice, MODEL_CHOICES, type EffortChoice, type ModelChoice } from '../../../shared/models';
import type { WorkspaceView } from '../../../shared/state';
import { shortPath } from '../viewModel';
import { TerminalHost } from './TerminalHost';

export interface DevPaneActions {
  cancelTask(id: string): void;
  resetSession(id: string): void;
  retryReview(id: string, taskId: string): void;
  restartTerminal(id: string): void;
  setModel(id: string, model: ModelChoice): void;
  /** null = Claude Code's default effort. */
  setEffort(id: string, effort: EffortChoice | null): void;
  /** Runs Claude Code's /clear in the terminal (clears the conversation context; never while a task runs). */
  clearTerminal(id: string): void;
}

interface Props {
  workspaces: WorkspaceView[];
  active: WorkspaceView | null;
  actions: DevPaneActions;
}

/**
 * The development pane (right column): one terminal per Workspace running the interactive Claude
 * (D026, D033).
 */
export function DevPane({ workspaces, active, actions }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const running = active?.task?.status === 'running' || active?.task?.status === 'queued';

  return (
    <section className="devpane" aria-label="Development pane">
      <header className="devpane-header">
        <div className="header-right">
          <button
            className="btn"
            disabled={!active || running || !(active?.terminal.running ?? false)}
            title={running ? 'Wait for the running Claude task to finish (/clear would be queued into its turn)' : 'Clear the Claude conversation context (/clear)'}
            onClick={() => active && actions.clearTerminal(active.id)}
          >
            Clear
          </button>
          <div className="seg model-seg" role="group" aria-label="Claude model">
            {MODEL_CHOICES.map((m) => (
              <button
                key={m}
                className={active?.model === m ? 'on' : ''}
                aria-pressed={active?.model === m}
                disabled={!active}
                title={running ? `Use ${m} from the next turn` : `Switch the terminal's Claude to ${m}`}
                onClick={() => active && active.model !== m && actions.setModel(active.id, m)}
              >
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <select
            className="effort-select"
            aria-label="Claude effort"
            value={active?.effort ?? ''}
            disabled={!active}
            title={running ? 'Applies from the next turn' : "Set the terminal's Claude effort level"}
            onChange={(e) => {
              const v = e.target.value;
              if (active) actions.setEffort(active.id, isEffortChoice(v) ? v : null);
            }}
          >
            <option value="">Default effort</option>
            {EFFORT_CHOICES.map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABELS[e]} effort
              </option>
            ))}
          </select>
          {running && (
            <button className="btn danger small" onClick={() => active && actions.cancelTask(active.id)}>
              Stop
            </button>
          )}
          <div className="menu-wrap">
            <button className="btn icon" aria-label="More" onClick={() => setMenuOpen((o) => !o)}>
              ⋯
            </button>
            {menuOpen && (
              <div className="menu" onMouseLeave={() => setMenuOpen(false)}>
                <button
                  disabled={running || !active}
                  onClick={() => {
                    setMenuOpen(false);
                    if (active) actions.resetSession(active.id);
                  }}
                >
                  New Claude session
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {active && (
        <div className="devpane-sub">
          <span title={active.projectPath}>{shortPath(active.projectPath)}</span>
          <span className="dot-sep">·</span>
          <span title={active.claudeSessionId ?? ''}>{active.claudeSessionId ? `Session ${active.claudeSessionId.slice(0, 8)}` : 'New session'}</span>
          {active.chatgpt.loggedIn === false && (
            <>
              <span className="dot-sep">·</span>
              <span className="warn-text">Log in to ChatGPT on the left</span>
            </>
          )}
        </div>
      )}

      {active?.latestReview?.status === 'failed' && (
        <div className="review-bar" role="status">
          <span className="review-title" title={active.latestReview.lastError ?? ''}>
            Result delivery failed
          </span>
          <button className="btn small primary" onClick={() => actions.retryReview(active.id, active.latestReview!.taskId)}>
            Retry
          </button>
        </div>
      )}

      <div className="devpane-body">
        <TerminalHost
          workspaceIds={workspaces.map((w) => w.id)}
          activeId={active?.id ?? null}
          visible={!!active}
          running={active?.terminal.running ?? true}
          error={active?.terminal.error ?? null}
          onRestart={() => active && actions.restartTerminal(active.id)}
        />
      </div>
    </section>
  );
}
