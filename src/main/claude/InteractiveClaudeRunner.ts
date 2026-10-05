import { readFileSync } from 'node:fs';
import { sanitizeTerminalPrompt } from '../../domain/prompt/promptText';
import type { ClaudeRunHandle, ClaudeRunRequest, ClaudeRunnerPort } from './ClaudeRunner';
import { lastAssistantText, type PromptSubmitEvent, type StopEvent } from './StopHookChannel';

/** What the runner needs from the Workspace terminal that hosts the interactive Claude. */
export interface InteractiveTerminal {
  isRunning(workspaceId: string): boolean;
  write(workspaceId: string, data: string): void;
  onExit(workspaceId: string, cb: () => void): () => void;
}

export interface StopSource {
  onStop(workspaceId: string, cb: (e: StopEvent) => void): () => void;
  onPromptSubmit(workspaceId: string, cb: (e: PromptSubmitEvent) => void): () => void;
  /** The user pressed Escape / Ctrl+C in the terminal. */
  onInterrupt(workspaceId: string, cb: () => void): () => void;
  /** A prompt was submitted and its turn has not stopped yet. */
  isBusy(workspaceId: string): boolean;
  /** The current turn was interrupted (it ends without a Stop event). */
  markIdle(workspaceId: string): void;
}

export const CLAUDE_BUSY_MESSAGE = 'Claude is still working in the terminal — wait for it to finish, then send again.';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const SUBMIT_DELAY_MS = 400;
/** Claude must report (`UserPromptSubmit`) that it received the pasted prompt within this time. */
const ACK_TIMEOUT_MS = 30_000;

/**
 * Managed runner for the interactive Claude that always runs in the Workspace terminal: the frozen
 * prompt is pasted into that Claude and submitted; the task completes on the first `Stop` hook event
 * after Claude reported (`UserPromptSubmit`) that it received this very prompt, so a Stop of an
 * earlier or the user's own turn never completes it. A run always ends deterministically, from hook and
 * process signals only (never from terminal output): Stop, the user's Escape / Ctrl+C (cancelled), the
 * terminal process ending or being replaced, or no acknowledgement of our prompt (while Claude is idle) within
 * `ackTimeoutMs`.
 */
export class InteractiveClaudeRunner implements ClaudeRunnerPort {
  constructor(
    private readonly terminal: InteractiveTerminal,
    private readonly stops: StopSource,
    private readonly readTranscript: (path: string) => string | null = (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    private readonly ackTimeoutMs = ACK_TIMEOUT_MS,
  ) {}

  start(req: ClaudeRunRequest): ClaudeRunHandle {
    let done = false;
    const cleanups: Array<() => void> = [];
    const finish = (code: number | null, spawnError: string | null, cancelled = false) => {
      if (done) return;
      done = true;
      for (const c of cleanups) c();
      req.onExit({ code, signal: null, spawnError, ...(cancelled ? { cancelled: true } : {}) });
    };

    if (!this.terminal.isRunning(req.workspaceId)) {
      queueMicrotask(() => finish(null, 'Claude is not running in the terminal. Restart it, then send again.'));
      return { cancel: () => {} };
    }

    if (this.stops.isBusy(req.workspaceId)) {
      queueMicrotask(() => finish(null, CLAUDE_BUSY_MESSAGE));
      return { cancel: () => {} };
    }

    const prompt = sanitizeTerminalPrompt(req.prompt);
    let submitted = false;
    cleanups.push(
      this.stops.onPromptSubmit(req.workspaceId, (e) => {
        if (done || submitted || !isSamePrompt(e.prompt, prompt)) return;
        submitted = true;
        req.onEvent({ type: 'submitted' });
      }),
      this.stops.onInterrupt(req.workspaceId, () => finish(null, null, true)),
      this.stops.onStop(req.workspaceId, (e) => {
        if (done || !submitted) return;
        const text = e.lastAssistantMessage ?? (e.transcriptPath ? lastAssistantText(this.readTranscript(e.transcriptPath) ?? '') : null);
        if (e.sessionId) req.onEvent({ type: 'init', sessionId: e.sessionId });
        req.onEvent({ type: 'result', isError: false, subtype: 'success', result: text, sessionId: e.sessionId });
        finish(0, null);
      }),
      this.terminal.onExit(req.workspaceId, () => finish(null, 'Claude exited in the terminal before finishing the task.')),
    );

    this.terminal.write(req.workspaceId, `${PASTE_START}${prompt}${PASTE_END}`);
    const submit = setTimeout(() => {
      if (!done) this.terminal.write(req.workspaceId, '\r');
    }, SUBMIT_DELAY_MS);
    // Our prompt was lost (input cleared, never submitted): without this the task would wait forever.
    // Claude working on another turn legitimately queues ours, so the clock only runs while it is idle.
    let ack: ReturnType<typeof setTimeout>;
    const armAck = () => {
      ack = setTimeout(() => {
        if (done || submitted) return;
        if (this.stops.isBusy(req.workspaceId)) return armAck();
        finish(null, 'Claude did not report receiving the prompt in the terminal. Check the terminal, then send again.');
      }, this.ackTimeoutMs);
    };
    armAck();
    cleanups.push(() => clearTimeout(submit), () => clearTimeout(ack));

    return {
      cancel: () => {
        if (done) return;
        this.terminal.write(req.workspaceId, '\x1b'); // Escape interrupts Claude's current turn
        this.stops.markIdle(req.workspaceId);
        finish(null, null, true);
      },
    };
  }
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Whether a UserPromptSubmit payload is the prompt we pasted. Whitespace is normalized. Claude Code wraps a
 * multi-line paste in `<pasted_content id="…">…</pasted_content id="…">` (and may shorten long prompts), so the
 * reported text matches when it starts with ours or contains our opening text after such a wrapper. A missing
 * prompt or a collapsed paste placeholder counts as ours (the event still arrived after our submit).
 */
export function isSamePrompt(reported: string | null, ours: string): boolean {
  const a = normalize(reported ?? '');
  if (!a || a.includes('[Pasted text')) return true;
  const b = normalize(ours);
  const n = Math.min(a.length, b.length, 200);
  if (a.length >= Math.min(b.length, 20) && a.slice(0, n) === b.slice(0, n)) return true;
  const unwrapped = a.replace(/^<pasted_content\b[^>]*>\s*/, '');
  const m = Math.min(unwrapped.length, b.length, 200);
  return unwrapped.length >= Math.min(b.length, 20) && unwrapped.slice(0, m) === b.slice(0, m);
}
