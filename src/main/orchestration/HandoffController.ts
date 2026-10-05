import { randomUUID } from 'node:crypto';
import { sanitizeTerminalPrompt } from '../../domain/handoff/promptText';
import type { AdapterResult, ClaudePromptCandidate } from '../chatgpt/ChatGPTAdapter';

/**
 * The single ChatGPT -> Claude boundary (D005, D017, D022, D024).
 *
 * ChatGPT activity (typing, sending messages, streaming replies, DOM observation) can at most update
 * the *candidate* via observeCandidate(). Only send(), called from the explicit Send to Claude
 * button/shortcut (or the user-requested auto-send, D034), captures the latest Claude Prompt block fresh and freezes it into a FrozenTask.
 */
export type HandoffTrigger =
  | 'button'
  | 'shortcut'
  | 'voice-command'
  /** The "Send to Claude" button on one prompt/code block: exactly that block's text, no capture. */
  | 'block-button'
  /** The user's own ChatGPT message asked for the prompt to be sent to Claude (D034); fired after a cancellable countdown. */
  | 'auto_user_request';

export interface FrozenTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly sourceMessageId: string | null;
  readonly conversationUrl: string | null;
  readonly trigger: HandoffTrigger;
  readonly createdAt: string;
}

export interface PromptCandidateSource {
  getLatestClaudePromptBlock(): Promise<AdapterResult<ClaudePromptCandidate>>;
}

export type FreezeResult = { ok: true; task: FrozenTask } | { ok: false; code: string; detail: string };

export class HandoffController {
  private readonly candidates = new Map<string, ClaudePromptCandidate>();

  constructor(
    private readonly newId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Passive: records the latest candidate. Never creates or launches a task. */
  observeCandidate(workspaceId: string, candidate: ClaudePromptCandidate | null): void {
    if (candidate) this.candidates.set(workspaceId, candidate);
    else this.candidates.delete(workspaceId);
  }

  getCandidate(workspaceId: string): ClaudePromptCandidate | null {
    return this.candidates.get(workspaceId) ?? null;
  }

  /** Explicit Send to Claude: capture the latest Claude Prompt block fresh and freeze exactly that text. */
  async send(workspaceId: string, source: PromptCandidateSource, trigger: HandoffTrigger): Promise<FreezeResult> {
    if (!workspaceId) return { ok: false, code: 'invalid_workspace', detail: 'workspaceId required' };
    const captured = await source.getLatestClaudePromptBlock();
    if (!captured.ok) return { ok: false, code: captured.code, detail: captured.detail };
    if (captured.value.truncated) return { ok: false, code: 'prompt_truncated', detail: 'Claude Prompt block exceeds the size limit' };
    this.candidates.set(workspaceId, captured.value);
    // The prompt is pasted into the terminal: no control characters or escape sequences.
    const prompt = sanitizeTerminalPrompt(captured.value.text);
    if (!prompt.trim()) return { ok: false, code: 'no_prompt_block', detail: 'Claude Prompt block is empty' };
    const task: FrozenTask = Object.freeze({
      taskId: this.newId(),
      workspaceId,
      prompt,
      sourceMessageId: captured.value.messageId,
      conversationUrl: captured.value.conversationUrl,
      trigger,
      createdAt: this.now().toISOString(),
    });
    return { ok: true, task };
  }

  /**
   * Freezes exactly the given text (the block whose button was clicked). Never reads the candidate or the page:
   * the text is the only source.
   */
  freezeText(workspaceId: string, text: string, sourceMessageId: string | null, conversationUrl: string | null, trigger: HandoffTrigger): FreezeResult {
    if (!workspaceId) return { ok: false, code: 'invalid_workspace', detail: 'workspaceId required' };
    const prompt = sanitizeTerminalPrompt(text);
    if (!prompt.trim()) return { ok: false, code: 'no_prompt_block', detail: 'The block is empty' };
    return {
      ok: true,
      task: Object.freeze({ taskId: this.newId(), workspaceId, prompt, sourceMessageId, conversationUrl, trigger, createdAt: this.now().toISOString() }),
    };
  }

  forget(workspaceId: string): void {
    this.candidates.delete(workspaceId);
  }
}
