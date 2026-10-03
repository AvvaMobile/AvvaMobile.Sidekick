import { useEffect, useState } from 'react';
import { MODEL_CHOICES, type ModelChoice } from '../../../shared/models';
import type { WorkspaceView } from '../../../shared/state';
import { needsReviewDecision, shortPath } from '../viewModel';
import { DiagnosticsPanel, type DiagnosticsApi } from './DiagnosticsPanel';
import { TerminalHost } from './TerminalHost';

export interface DevPaneActions {
  sendToClaude(id: string): void;
  /** Cancels the user-requested auto-send countdown. */
  cancelAutoSend(id: string): void;
  cancelTask(id: string): void;
  resetSession(id: string): void;
  sendReview(id: string, taskId: string): void;
  restartTerminal(id: string): void;
  setModel(id: string, model: ModelChoice): void;
  /** Runs Claude Code's /clear in the terminal. */
  clearTerminal(id: string): void;
  /** Runs Claude Code's /copy in the terminal (copies the last response). */
  copyTerminal(id: string): void;
}

interface Props {
  workspaces: WorkspaceView[];
  active: WorkspaceView | null;
  debugMode: boolean;
  actions: DevPaneActions;
  diagnostics: DiagnosticsApi;
}

/**
 * The development pane (right column): one terminal per Workspace running the interactive Claude
 * (D026, D033). Adapter diagnostics only in Developer mode (D025).
 */
export function DevPane({ workspaces, active, debugMode, actions, diagnostics }: Props) {
  const [showDiag, setShowDiag] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hiddenReview, setHiddenReview] = useState<string | null>(null);
  useEffect(() => {
    if (!debugMode) setShowDiag(false);
  }, [debugMode]);

  const running = active?.task?.status === 'running' || active?.task?.status === 'queued';
  const review = needsReviewDecision(active) && active!.task!.id !== hiddenReview ? active!.task! : null;
  const pendingReviewHidden = needsReviewDecision(active) && active!.task!.id === hiddenReview;

  return (
    <section className="devpane" aria-label="Development pane">
      <header className="devpane-header">
        <div className="header-right">
          {pendingReviewHidden && (
            <button className="chip review-chip" onClick={() => setHiddenReview(null)}>
              Review pending
            </button>
          )}
          <button
            className="btn"
            disabled={!active || running || !(active?.terminal.running ?? false)}
            title="Clear the Claude conversation (/clear)"
            onClick={() => active && actions.clearTerminal(active.id)}
          >
            Clear
          </button>
          <button
            className="btn"
            disabled={!active || running || !(active?.terminal.running ?? false)}
            title="Copy the last Claude response (/copy)"
            onClick={() => active && actions.copyTerminal(active.id)}
          >
            Copy
          </button>
          <div className="seg model-seg" role="group" aria-label="Claude model">
            {MODEL_CHOICES.map((m) => (
              <button
                key={m}
                className={active?.model === m ? 'on' : ''}
                aria-pressed={active?.model === m}
                disabled={!active || running}
                title={running ? 'Wait for the running Claude task to finish' : `Switch the terminal's Claude to ${m}`}
                onClick={() => active && active.model !== m && actions.setModel(active.id, m)}
              >
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          {running && (
            <button className="btn danger small" onClick={() => active && actions.cancelTask(active.id)}>
              Stop
            </button>
          )}
          {debugMode && (
            <button className={`btn small ${showDiag ? 'on' : ''}`} onClick={() => setShowDiag((v) => !v)}>
              {showDiag ? 'Terminal' : 'Diagnostics'}
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

      {active?.autoSend && <AutoSendBar at={active.autoSend.at} onCancel={() => actions.cancelAutoSend(active.id)} />}

      {review && active && (
        <div className={`review-bar ${review.outcome === 'succeeded' ? '' : 'bad'}`}>
          <span className="review-title">
            {review.outcome === 'succeeded' ? 'Claude finished.' : `Claude ${review.outcome}.`}
            {review.review?.status === 'failed' && <span className="review-error"> {review.review.lastError}</span>}
          </span>
          <button className="btn primary small" disabled={review.review?.status === 'sending'} onClick={() => actions.sendReview(active.id, review.id)}>
            {review.review?.status === 'sending' ? 'Sending…' : review.review?.status === 'failed' ? 'Retry review' : 'Send to ChatGPT for review'}
          </button>
          <button className="btn ghost small" onClick={() => setHiddenReview(review.id)}>
            Not now
          </button>
        </div>
      )}

      <div className="devpane-body">
        <TerminalHost
          workspaceIds={workspaces.map((w) => w.id)}
          activeId={active?.id ?? null}
          visible={!showDiag && !!active}
          running={active?.terminal.running ?? true}
          error={active?.terminal.error ?? null}
          onRestart={() => active && actions.restartTerminal(active.id)}
        />
        {debugMode && showDiag && <DiagnosticsPanel api={diagnostics} />}
      </div>
    </section>
  );
}

/** Live countdown for the user-requested auto-send (D034). */
function AutoSendBar({ at, onCancel }: { at: string; onCancel(): void }) {
  const left = () => Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 1000));
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    setSecs(left());
    const t = setInterval(() => setSecs(left()), 250);
    return () => clearInterval(t);
  }, [at]);
  return (
    <div className="review-bar auto-send-bar" role="status">
      <span className="review-title">
        Sending to Claude in {secs} s <span className="auto-send-why">— you asked ChatGPT to send it</span>
      </span>
      <button className="btn ghost small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
