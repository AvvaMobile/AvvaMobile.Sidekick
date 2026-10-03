import { readFileSync } from 'node:fs';
import { sanitizeTerminalPrompt } from '../../domain/handoff/promptText';
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
  /** A prompt was submitted and its turn has not stopped yet. */
  isBusy(workspaceId: string): boolean;
  /** The current turn was interrupted (it ends without a Stop event). */
  markIdle(workspaceId: string): void;
}

export const CLAUDE_BUSY_MESSAGE = 'Claude is still working in the terminal — wait for it to finish, then send again.';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const SUBMIT_DELAY_MS = 400;

/**
 * Managed runner for the interactive Claude that always runs in the Workspace terminal: the frozen
 * prompt is pasted into that Claude and submitted; the task completes on the first `Stop` hook event
 * after Claude reported (`UserPromptSubmit`) that it received this very prompt, so a Stop of an
 * earlier or the user's own turn never completes it.
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
  ) {}

  start(req: ClaudeRunRequest): ClaudeRunHandle {
    let done = false;
    const cleanups: Array<() => void> = [];
    const finish = (code: number | null, spawnError: string | null) => {
      if (done) return;
      done = true;
      for (const c of cleanups) c();
      req.onExit({ code, signal: null, spawnError });
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
        if (!done && !submitted && isSamePrompt(e.prompt, prompt)) submitted = true;
      }),
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
    cleanups.push(() => clearTimeout(submit));

    return {
      cancel: () => {
        if (done) return;
        this.terminal.write(req.workspaceId, '\x1b'); // Escape interrupts Claude's current turn
        this.stops.markIdle(req.workspaceId);
        finish(null, null);
      },
    };
  }
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Whether a UserPromptSubmit payload is the prompt we pasted. Whitespace is normalized and a prefix
 * is compared (Claude may shorten long prompts); a missing prompt or a collapsed paste placeholder
 * counts as ours (the event still arrived after our submit).
 */
export function isSamePrompt(reported: string | null, ours: string): boolean {
  const a = normalize(reported ?? '');
  if (!a || a.includes('[Pasted text')) return true;
  const b = normalize(ours);
  const n = Math.min(a.length, b.length, 200);
  return a.length >= Math.min(b.length, 20) && a.slice(0, n) === b.slice(0, n);
}
