import type { WebContents } from 'electron';
import { conversationUrlToStore, isChatGptAppUrl, isChatGptConversationUrl, sameConversationUrl } from '../security/origins';
import {
  CLAUDE_PROMPT_LANGUAGE,
  SELECTORS,
  clickSendScript,
  composerTextScript,
  focusComposerScript,
  latestClaudePromptBlockScript,
  latestMessageTextScript,
  pageStateScript,
  scriptCall,
  type PageScript,
  type LatestTextResult,
  type PageState,
} from './pageScripts';

/** Isolated world id for Workspace adapter scripts (page JS cannot see this world's globals). */
const ADAPTER_WORLD_ID = 1001;
const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_PROMPT_CHARS = 100_000;

export type AdapterErrorCode =
  | 'view_unavailable'
  | 'wrong_origin'
  | 'timeout'
  | 'script_error'
  | 'composer_not_found'
  | 'composer_not_empty'
  | 'insert_mismatch'
  | 'send_button_not_found'
  | 'send_button_disabled'
  | 'still_generating'
  | 'no_assistant_messages'
  | 'no_prompt_block'
  | 'not_found'
  /** The conversation a result belongs to is unknown or could not be opened. */
  | 'conversation_unavailable';

export type AdapterResult<T> = { ok: true; value: T } | { ok: false; code: AdapterErrorCode; detail: string };

export interface ClaudePromptCandidate {
  text: string;
  messageId: string | null;
  conversationUrl: string | null;
  truncated: boolean;
  capturedAt: string;
}

/**
 * The only component that knows how to talk to the ChatGPT page. All DOM knowledge is in pageScripts.ts.
 * Every operation verifies origin, times out and returns a typed result.
 */
export class ChatGPTAdapter {
  constructor(private readonly wc: WebContents) {}

  getConversationUrl(): string | null {
    if (this.wc.isDestroyed()) return null;
    const url = this.wc.getURL();
    // Origin and path only: a query or fragment can carry tokens and is never stored.
    return isChatGptConversationUrl(url) ? conversationUrlToStore(url) : null;
  }

  /**
   * Makes sure the view shows exactly `expectedUrl` (the conversation a managed task started from) before
   * anything is inserted. Already there: nothing happens. Elsewhere in the same Workspace: navigates back
   * and waits for the composer. Anything uncertain fails; the caller never guesses another conversation.
   */
  async ensureConversation(expectedUrl: string | null): Promise<AdapterResult<{ restored: boolean }>> {
    if (!expectedUrl || !isChatGptConversationUrl(expectedUrl)) return { ok: false, code: 'conversation_unavailable', detail: 'The source conversation is unknown' };
    if (this.wc.isDestroyed()) return { ok: false, code: 'view_unavailable', detail: 'ChatGPT view destroyed' };
    if (sameConversationUrl(this.wc.getURL(), expectedUrl)) return { ok: true, value: { restored: false } };
    try {
      await this.wc.loadURL(conversationUrlToStore(expectedUrl));
    } catch (err) {
      return { ok: false, code: 'conversation_unavailable', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (this.wc.isDestroyed()) return { ok: false, code: 'view_unavailable', detail: 'ChatGPT view destroyed' };
      if (!sameConversationUrl(this.wc.getURL(), expectedUrl)) return { ok: false, code: 'conversation_unavailable', detail: 'ChatGPT did not open the source conversation' };
      const composer = await this.run(scriptCall(composerTextScript, { sel: SELECTORS }));
      if (composer.ok && composer.value.ok) return { ok: true, value: { restored: true } };
      await delay(500);
    }
    return { ok: false, code: 'conversation_unavailable', detail: 'The source conversation did not become ready' };
  }

  async getPageState(): Promise<AdapterResult<PageState>> {
    return this.run(scriptCall(pageStateScript, SELECTORS));
  }

  async getLatestClaudePromptBlock(): Promise<AdapterResult<ClaudePromptCandidate>> {
    const res = await this.run(
      scriptCall(latestClaudePromptBlockScript, { sel: SELECTORS, language: CLAUDE_PROMPT_LANGUAGE, maxChars: MAX_PROMPT_CHARS }),
    );
    if (!res.ok) return res;
    const r = res.value;
    if (!r.ok) return { ok: false, code: r.code, detail: r.detail };
    return {
      ok: true,
      value: {
        text: r.text,
        messageId: r.messageId,
        conversationUrl: this.getConversationUrl(),
        truncated: r.truncated,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  async getLatestUserMessage(maxChars = 2_000): Promise<AdapterResult<LatestTextResult & { ok: true }>> {
    return this.latestText(SELECTORS.userMessage, maxChars);
  }

  /**
   * Inserts text into the composer using native text input (webContents.insertText).
   * Refuses to overwrite a draft the user is typing unless allowNonEmpty is set.
   */
  async insertComposerText(text: string, opts: { allowNonEmpty?: boolean } = {}): Promise<AdapterResult<{ inserted: number }>> {
    const focus = await this.run(scriptCall(focusComposerScript, { sel: SELECTORS, requireEmpty: !opts.allowNonEmpty }));
    if (!focus.ok) return focus;
    if (!focus.value.ok) return { ok: false, code: focus.value.code, detail: focus.value.detail };
    if (!this.wc.isFocused()) this.wc.focus();
    await this.wc.insertText(text);
    const after = await this.run(scriptCall(composerTextScript, { sel: SELECTORS }));
    if (!after.ok) return after;
    if (!after.value.ok || !normalizeWs(after.value.text).includes(normalizeWs(text).slice(0, 200))) {
      return { ok: false, code: 'insert_mismatch', detail: 'composer content does not contain inserted text' };
    }
    return { ok: true, value: { inserted: text.length } };
  }

  async submitComposer(): Promise<AdapterResult<{ via: string }>> {
    // Give the composer a moment to enable the send button after insertion.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await this.run(scriptCall(clickSendScript, { sel: SELECTORS }));
      if (!res.ok) return res;
      if (res.value.ok) return { ok: true, value: { via: res.value.via } };
      if (res.value.code !== 'send_button_disabled') return { ok: false, code: res.value.code, detail: res.value.detail };
      await delay(150);
    }
    return { ok: false, code: 'send_button_disabled', detail: 'send button stayed disabled' };
  }

  private async latestText(selector: string, maxChars: number): Promise<AdapterResult<LatestTextResult & { ok: true }>> {
    const res = await this.run(scriptCall(latestMessageTextScript, { selector, maxChars }));
    if (!res.ok) return res;
    if (!res.value.ok) return { ok: false, code: 'not_found', detail: res.value.detail };
    return { ok: true, value: res.value };
  }

  private async run<T>(code: PageScript<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AdapterResult<T>> {
    if (this.wc.isDestroyed()) return { ok: false, code: 'view_unavailable', detail: 'ChatGPT view destroyed' };
    const url = this.wc.getURL();
    if (!isChatGptAppUrl(url)) return { ok: false, code: 'wrong_origin', detail: 'ChatGPT view is not on an approved ChatGPT origin' };
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        this.wc.executeJavaScriptInIsolatedWorld(ADAPTER_WORLD_ID, [{ code }]) as Promise<T>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      // Re-check origin: the page may have navigated while the script ran.
      if (!isChatGptAppUrl(this.wc.getURL())) return { ok: false, code: 'wrong_origin', detail: 'navigated during operation' };
      return { ok: true, value };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'timeout') return { ok: false, code: 'timeout', detail: `adapter script timed out after ${timeoutMs}ms` };
      return { ok: false, code: 'script_error', detail: msg.slice(0, 300) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
