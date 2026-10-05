import type { WorkspaceView } from '../../../shared/state';
import { claudeStatus, type ClaudeStatus } from '../viewModel';

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
  style: React.CSSProperties;
  /** Retries delivering the stored result to ChatGPT (shown only after a failed automatic delivery). */
  onRetry(): void;
  onStop(): void;
  onOpenClaude(): void;
}

/**
 * ChatGPT Focus: slim Claude strip under ChatGPT (state, Stop, delivery Retry). Claude keeps working
 * whether or not its terminal is visible.
 */
export function ClaudeStatusBar({ active, style, onRetry, onStop, onOpenClaude }: Props) {
  const status = claudeStatus(active);
  return (
    <div className="status-bar" style={style} role="status" aria-label="Claude status">
      <span className={`status-dot ${status}`} aria-hidden="true" />
      <span className="status-label">Claude: {LABEL[status]}</span>
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
      <button className="btn small" onClick={onOpenClaude} title="Show Claude's terminal full size (Claude Focus)">
        Open Claude
      </button>
    </div>
  );
}
