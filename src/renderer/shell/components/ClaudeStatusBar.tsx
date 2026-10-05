import type { WorkspaceView } from '../../../shared/state';
import { claudeStatus, sendState, type ClaudeStatus } from '../viewModel';
import { AutoSendBar, AutoSendNotice } from './DevPane';

const LABEL: Record<ClaudeStatus, string> = {
  idle: 'Idle',
  running: 'Running…',
  sending: 'Completed — sending result to ChatGPT…',
  delivered: 'Result delivered',
  'delivery-failed': 'Result delivery failed',
  failed: 'Failed',
};

interface Props {
  active: WorkspaceView;
  busy: boolean;
  style: React.CSSProperties;
  onSend(): void;
  /** Retries delivering the stored result to ChatGPT (shown only after a failed automatic delivery). */
  onRetry(): void;
  onStop(): void;
  onCancelAutoSend(): void;
  onOpenClaude(): void;
}

/**
 * ChatGPT Focus: slim Claude strip under ChatGPT. It drives the same Workspace task as the Split view
 * (same handlers); Claude keeps working whether or not its terminal is visible.
 */
export function ClaudeStatusBar({ active, busy, style, onSend, onRetry, onStop, onCancelAutoSend, onOpenClaude }: Props) {
  const status = claudeStatus(active);
  const send = sendState(active);
  return (
    <div className="status-bar" style={style} role="status" aria-label="Claude status">
      <span className={`status-dot ${status}`} aria-hidden="true" />
      <span className="status-label">Claude: {LABEL[status]}</span>
      {send.enabled && <span className="status-hint">Prompt ready</span>}
      {active.autoSend && <AutoSendBar at={active.autoSend.at} onCancel={onCancelAutoSend} compact />}
      {active.autoSendNotice && !active.autoSend && <AutoSendNotice notice={active.autoSendNotice} compact />}
      <span className="status-spacer" />
      {status === 'running' && (
        <button className="btn danger small" onClick={onStop}>
          Stop
        </button>
      )}
      {status === 'delivery-failed' && (
        <button className="btn small primary" onClick={onRetry} title={active.latestReview?.lastError ?? 'Deliver the result to ChatGPT again (Claude is not re-run)'}>
          Retry
        </button>
      )}
      {status !== 'running' && (
        <button className="btn small primary" disabled={!send.enabled || busy} onClick={onSend} title={send.enabled ? 'Send the latest Claude Prompt block to Claude Code' : send.reason}>
          Send to Claude
        </button>
      )}
      <button className="btn small" onClick={onOpenClaude} title="Show Claude's terminal full size (Claude Focus)">
        Open Claude
      </button>
    </div>
  );
}
