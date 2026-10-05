import { useEffect, useState } from 'react';
import { EFFORT_CHOICES, EFFORT_LABELS, isEffortChoice, MODEL_CHOICES, type EffortChoice, type ModelChoice } from '../../../shared/models';
import type { BlockInfo, CopyTarget } from '../../../shared/response';
import type { WorkspaceView } from '../../../shared/state';
import { shortPath } from '../viewModel';
import { DiagnosticsPanel, type DiagnosticsApi } from './DiagnosticsPanel';
import { TerminalHost } from './TerminalHost';

export interface DevPaneActions {
  sendToClaude(id: string): void;
  /** Cancels the user-requested auto-send countdown. */
  cancelAutoSend(id: string): void;
  cancelTask(id: string): void;
  resetSession(id: string): void;
  retryReview(id: string, taskId: string): void;
  restartTerminal(id: string): void;
  setModel(id: string, model: ModelChoice): void;
  /** null = Claude Code's default effort. */
  setEffort(id: string, effort: EffortChoice | null): void;
  /** Runs Claude Code's /clear in the terminal (clears the conversation context; never while a task runs). */
  clearTerminal(id: string): void;
  /** Code blocks of Claude's last completed response (labels for the Copy menu). */
  responseInfo(id: string): Promise<{ available: boolean; blocks: BlockInfo[] }>;
  /** Copies part of the last response to the clipboard (main process); `blocks` set = the user must pick one. */
  copyResponse(id: string, target: CopyTarget): Promise<{ ok: boolean; blocks?: BlockInfo[] }>;
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
  /** Copy menu: the code blocks to choose from (`null` = closed). */
  const [copyChoices, setCopyChoices] = useState<BlockInfo[] | null>(null);
  useEffect(() => {
    if (!debugMode) setShowDiag(false);
  }, [debugMode]);

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
          <div className="menu-wrap copy-wrap" onMouseLeave={() => setCopyChoices(null)}>
            <div className="seg copy-seg" role="group" aria-label="Copy Claude response">
              <button
                disabled={!active}
                title="Copy the code of Claude's last response (the full response when it has no code)"
                onClick={() => {
                  if (!active) return;
                  void actions.copyResponse(active.id, 'auto').then((r) => r.blocks && setCopyChoices(r.blocks));
                }}
              >
                Copy
              </button>
              <button
                aria-label="More copy options"
                disabled={!active}
                title="More copy options"
                onClick={() => {
                  if (!active) return;
                  if (copyChoices) return setCopyChoices(null);
                  void actions.responseInfo(active.id).then((i) => setCopyChoices(i.blocks.length > 1 ? i.blocks : []));
                }}
              >
                ▾
              </button>
            </div>
            {copyChoices && (
              <div className="menu copy-menu">
                {copyChoices.map((b, i) => (
                  <button
                    key={i}
                    title={b.preview}
                    onClick={() => {
                      setCopyChoices(null);
                      if (active) void actions.copyResponse(active.id, { block: i });
                    }}
                  >
                    Code block {i + 1}
                    {b.language ? ` — ${b.language}` : ''}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setCopyChoices(null);
                    if (active) void actions.copyResponse(active.id, 'full');
                  }}
                >
                  {copyChoices.length > 1 ? 'Full response' : 'Copy full response'}
                </button>
              </div>
            )}
          </div>
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
      {active?.autoSendNotice && !active.autoSend && <AutoSendNotice notice={active.autoSendNotice} />}
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
export function AutoSendBar({ at, onCancel, compact = false }: { at: string; onCancel(): void; compact?: boolean }) {
  const left = () => Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 1000));
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    setSecs(left());
    const t = setInterval(() => setSecs(left()), 250);
    return () => clearInterval(t);
  }, [at]);
  return (
    <div className={`review-bar auto-send-bar ${compact ? 'compact' : ''}`} role="status">
      <span className="review-title">
        Sending to Claude in {secs} s <span className="auto-send-why">— you asked ChatGPT to send it</span>
      </span>
      <button className="btn ghost small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** Why "send it to Claude" did not start; fades after a few seconds. */
export function AutoSendNotice({ notice, compact = false }: { notice: { text: string; at: string }; compact?: boolean }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    setShown(true);
    const t = setTimeout(() => setShown(false), 8_000);
    return () => clearTimeout(t);
  }, [notice.at, notice.text]);
  if (!shown) return null;
  return (
    <div className={`review-bar auto-send-bar ${compact ? 'compact' : ''}`} role="status">
      <span className="review-title">{notice.text}</span>
    </div>
  );
}
