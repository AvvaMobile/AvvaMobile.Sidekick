/**
 * Functions executed inside the ChatGPT page, in an *isolated world* (not the page's JS world).
 *
 * Rules (docs/ARCHITECTURE.md §5-6):
 * - every function is fully self-contained: it is serialized with Function#toString(), so it must not
 *   reference imports, module constants or helpers defined outside its own body;
 * - all ChatGPT DOM knowledge lives in this file;
 * - results are small typed objects, never page HTML;
 * - no clicks on unknown controls, no screen coordinates.
 */

export interface PageSelectors {
  assistantMessage: string;
  incompleteAssistant: string;
  userMessage: string;
  composer: string;
  sendButton: string;
  stopButton: string;
  loginButton: string;
  voiceButton: string;
  /** ChatGPT "writing block" (rich, editable block rendered inside assistant messages). */
  writingBlock: string;
  /** 2026 UI fenced code block container (no <pre>); its header shows the language label. */
  codeBlock: string;
}

/** Centralized selectors. Prefer data-testid / semantic attributes over generated class names. */
export const SELECTORS: PageSelectors = {
  // 2026 logged-in UI: turns are `[data-content-search-unit-key="…:assistant"]` (no role attributes).
  assistantMessage: '[data-message-author-role="assistant"], li[data-message-role="assistant"], [data-content-search-unit-key$=":assistant"]',
  userMessage: '[data-message-author-role="user"], li[data-message-role="user"], [data-content-search-unit-key$=":user"]',
  /** An assistant turn that is still streaming (2026 "octane" UI marks finished turns with data-message-complete). */
  incompleteAssistant: 'li[data-message-role="assistant"]:not([data-message-complete])',
  // Writing blocks also contain a contenteditable ProseMirror; scripts exclude anything inside `writingBlock`.
  composer:
    '[data-composer-markdown][contenteditable="true"], #prompt-textarea, textarea[name="prompt"], textarea[aria-label="Chat with ChatGPT"], form div[contenteditable="true"].ProseMirror',
  sendButton:
    'button[data-testid="send-button"], button#composer-submit-button, button[aria-label="Send message"], button[aria-label="Send prompt"], form button[aria-label="Send"]',
  stopButton:
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="Stop response"], form button[aria-label="Stop"]',
  loginButton: '[data-testid="login-button"], button[data-testid="welcome-login-button"], [aria-label$="Log in to use."]',
  voiceButton:
    'button[data-testid="composer-speech-button"], button[aria-label="Start voice mode"], button[aria-label*="voice mode" i], button[aria-label="Start Voice"]',
  writingBlock: '[data-oai-writing-block-surface], [data-testid="chatgpt-writing-block"]',
  codeBlock: '[data-markdown-copy="code-block"]',
};

/** Language tag for the designated Claude Prompt fenced block: ```claude-prompt */
export const CLAUDE_PROMPT_LANGUAGE = 'claude-prompt';

export interface PageState {
  url: string;
  composerFound: boolean;
  loggedOutMarkers: boolean;
  generating: boolean;
  assistantMessageCount: number;
  userMessageCount: number;
  voiceButtonFound: boolean;
  /** Lightweight DOM fingerprint for compatibility diagnostics (counts only). */
  fingerprint: Record<string, number>;
}

export function pageStateScript(sel: PageSelectors): PageState {
  const q = (s: string) => document.querySelectorAll(s).length;
  const composer = Array.from(document.querySelectorAll(sel.composer)).find((el) => !el.closest(sel.writingBlock));
  return {
    url: location.href,
    composerFound: !!composer,
    loggedOutMarkers: q(sel.loginButton) > 0,
    generating: q(sel.stopButton) > 0 || q(sel.incompleteAssistant) > 0,
    assistantMessageCount: q(sel.assistantMessage),
    userMessageCount: q(sel.userMessage),
    voiceButtonFound: q(sel.voiceButton) > 0,
    fingerprint: {
      'data-message-id': q('[data-message-id]'),
      'data-message-role': q('[data-message-role]'),
      'conversation-transcript': q('[data-conversation-transcript]'),
      'conversation-turn': q('[data-testid^="conversation-turn-"]'),
      pre: q('pre'),
      'code[class*=language-]': q('code[class*="language-"]'),
      prosemirror: q('.ProseMirror'),
      'writing-block': q(sel.writingBlock),
      'content-search-unit': q('[data-content-search-unit-key]'),
      textarea: q('textarea'),
    },
  };
}

export type PromptBlockResult =
  | {
      ok: true;
      text: string;
      messageId: string | null;
      /** 0-based index of the block within its message (multiple claude-prompt blocks: the last wins). */
      blockIndex: number;
      /** How many assistant messages back from the latest one the block was found (0 = latest). */
      messagesBack: number;
      truncated: boolean;
      /** tagged: claude-prompt fence/label or Claude-titled writing block; boxed: D032 (any writing block / plain-text block). */
      designation: 'tagged' | 'boxed';
    }
  | { ok: false; code: 'no_assistant_messages' | 'no_prompt_block' | 'still_generating'; detail: string };

/**
 * Finds the most recent assistant message that contains a designated Claude Prompt block and
 * returns only that block's text. A block is designated when:
 *   - its code language is `claude-prompt` (``` claude-prompt fence), or
 *   - its rendered header label reads `claude-prompt`, or
 *   - it is a ChatGPT writing block whose title mentions Claude (e.g. "Claude test prompt") —
 *     what ChatGPT produces when asked for "a prompt for Claude" in the 2026 UI.
 * Otherwise (D032) the message's last "box" is used: any writing block (whatever its title) or a
 * plain-text/markdown/unlabeled code block. Code in other languages (bash, ts, …) is never used.
 * Surrounding prose is never returned. The newest message containing a usable block wins.
 */
export function latestClaudePromptBlockScript(args: {
  sel: PageSelectors;
  language: string;
  maxChars: number;
}): PromptBlockResult {
  const { sel, language, maxChars } = args;
  if (document.querySelector(sel.stopButton) || document.querySelector(sel.incompleteAssistant)) {
    return { ok: false, code: 'still_generating', detail: 'ChatGPT is still generating a response' };
  }
  const messages = Array.from(document.querySelectorAll(sel.assistantMessage));
  if (messages.length === 0) return { ok: false, code: 'no_assistant_messages', detail: 'no assistant messages found' };

  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

  const isWritingBlock = (el: Element): boolean => el.matches(sel.writingBlock);
  const isCodeBlock = (el: Element): boolean => el.matches(sel.codeBlock);

  /** Language of a fenced block: `language-x` class, data-language or the rendered header label. */
  const languageOf = (el: Element): string => {
    const code = el.querySelector('code');
    if (code) {
      for (const cls of Array.from(code.classList)) {
        if (cls.startsWith('language-')) return norm(cls.slice('language-'.length));
        if (cls.startsWith('lang-')) return norm(cls.slice('lang-'.length));
      }
      if (code.getAttribute('data-language')) return norm(code.getAttribute('data-language'));
    }
    if (el.getAttribute('data-language')) return norm(el.getAttribute('data-language'));
    if (isCodeBlock(el)) return norm(el.querySelector('[data-markdown-copy="exclude"]')?.textContent);
    for (const l of Array.from(el.querySelectorAll('div, span'))) {
      const t = norm(l.textContent);
      if (l.children.length === 0 && t && t.length < 30 && !l.closest('code')) return t;
    }
    return '';
  };

  const isDesignated = (el: Element): boolean => {
    if (isWritingBlock(el)) {
      if (norm(el.getAttribute('data-language')) === language) return true;
      const title = norm(el.querySelector('header')?.textContent);
      return title === language || /\bclaude\b/.test(title);
    }
    return languageOf(el) === language;
  };

  const PLAIN = ['', 'plain text', 'plaintext', 'text', 'txt', 'markdown', 'md', 'prompt'];
  const isBoxBlock = (el: Element): boolean => isWritingBlock(el) || PLAIN.includes(languageOf(el));

  /** A writing block's markdown may itself be one fenced block (```text … ```): return its body. */
  const unwrapFence = (md: string): string => {
    const m = md.trim().match(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/);
    return m ? m[2]! : md;
  };

  const blockText = (el: Element): string => {
    let raw: string;
    if (isWritingBlock(el)) {
      const content = el.querySelector('[data-markdown-copy-content]') as HTMLElement | null;
      const md = el.getAttribute('data-markdown-copy-text');
      raw = md != null ? unwrapFence(md) : (content?.innerText ?? content?.textContent ?? '');
    } else {
      const code = el.querySelector('code');
      raw = (code ?? el).textContent ?? '';
    }
    return raw.replace(/ /g, ' ').replace(/\s+$/, '');
  };

  const messageIdOf = (msg: Element): string | null =>
    msg.getAttribute('data-message-id') ??
    msg.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id') ??
    msg.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/)[0] ??
    (msg.id || null);

  const blockSel = 'pre, ' + sel.writingBlock + ', ' + sel.codeBlock;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    // Outermost blocks only (a <pre>/<code> inside a code-block container or writing block is the same block).
    const blocks = Array.from(msg.querySelectorAll(blockSel)).filter((el) => !el.parentElement?.closest(blockSel));
    let pick = -1;
    let designation: 'tagged' | 'boxed' = 'tagged';
    for (let b = blocks.length - 1; b >= 0 && pick < 0; b--) if (isDesignated(blocks[b]!) && blockText(blocks[b]!).trim()) pick = b;
    if (pick < 0) {
      designation = 'boxed';
      for (let b = blocks.length - 1; b >= 0 && pick < 0; b--) if (isBoxBlock(blocks[b]!) && blockText(blocks[b]!).trim()) pick = b;
    }
    if (pick < 0) continue;
    const full = blockText(blocks[pick]!);
    const truncated = full.length > maxChars;
    return {
      ok: true,
      text: truncated ? full.slice(0, maxChars) : full,
      messageId: messageIdOf(msg),
      blockIndex: pick,
      messagesBack: messages.length - 1 - i,
      truncated,
      designation,
    };
  }
  return { ok: false, code: 'no_prompt_block', detail: 'no ```' + language + ' block in assistant messages' };
}

export type LatestTextResult =
  | { ok: true; text: string; messageId: string | null; truncated: boolean }
  | { ok: false; code: 'not_found'; detail: string };

/** Latest message text of a role (used for diagnostics and the voice-command path). */
export function latestMessageTextScript(args: { selector: string; maxChars: number }): LatestTextResult {
  const all = document.querySelectorAll(args.selector);
  const last = all[all.length - 1];
  if (!last) return { ok: false, code: 'not_found', detail: 'no message for selector' };
  const text = ((last as HTMLElement).innerText ?? last.textContent ?? '').trim();
  return {
    ok: true,
    text: text.slice(0, args.maxChars),
    // 2026 UI turns carry no message id: their content-search unit key ("<thread>:<turn>:<role>") is stable.
    messageId:
      last.getAttribute('data-message-id') ??
      last.closest('[data-content-search-unit-key]')?.getAttribute('data-content-search-unit-key') ??
      (last.id || null),
    truncated: text.length > args.maxChars,
  };
}

export type FocusComposerResult =
  | { ok: true; wasEmpty: boolean; kind: 'contenteditable' | 'textarea' }
  | { ok: false; code: 'composer_not_found' | 'composer_not_empty'; detail: string };

/**
 * Focuses the composer and moves the caret to the end so the main process can insert text with
 * webContents.insertText (trusted native text input, no synthetic DOM mutation).
 */
export function focusComposerScript(args: { sel: PageSelectors; requireEmpty: boolean }): FocusComposerResult {
  const el = (Array.from(document.querySelectorAll(args.sel.composer)).find((c) => !c.closest(args.sel.writingBlock)) ?? null) as HTMLElement | null;
  if (!el) return { ok: false, code: 'composer_not_found', detail: 'composer element not found' };
  const isTextarea = el.tagName === 'TEXTAREA';
  const current = isTextarea ? (el as HTMLTextAreaElement).value : (el.innerText ?? '');
  const wasEmpty = current.trim().length === 0;
  if (args.requireEmpty && !wasEmpty) {
    return { ok: false, code: 'composer_not_empty', detail: 'composer already contains user text' };
  }
  el.focus();
  if (isTextarea) {
    const ta = el as HTMLTextAreaElement;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
  }
  return { ok: true, wasEmpty, kind: isTextarea ? 'textarea' : 'contenteditable' };
}

export interface ComposerTextResult {
  ok: boolean;
  text: string;
}

export function composerTextScript(args: { sel: PageSelectors }): ComposerTextResult {
  const el = (Array.from(document.querySelectorAll(args.sel.composer)).find((c) => !c.closest(args.sel.writingBlock)) ?? null) as HTMLElement | null;
  if (!el) return { ok: false, text: '' };
  const text = el.tagName === 'TEXTAREA' ? (el as HTMLTextAreaElement).value : (el.innerText ?? '');
  return { ok: true, text };
}

export type SubmitResult =
  | { ok: true; via: 'send-button' }
  | { ok: false; code: 'send_button_not_found' | 'send_button_disabled' | 'still_generating'; detail: string };

/** Clicks ChatGPT's own send button, identified by data-testid / id only. */
export function clickSendScript(args: { sel: PageSelectors }): SubmitResult {
  if (document.querySelector(args.sel.stopButton)) {
    return { ok: false, code: 'still_generating', detail: 'a response is still being generated' };
  }
  const btn = document.querySelector(args.sel.sendButton) as HTMLButtonElement | null;
  if (!btn) return { ok: false, code: 'send_button_not_found', detail: 'send button not found' };
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
    return { ok: false, code: 'send_button_disabled', detail: 'send button disabled' };
  }
  btn.click();
  return { ok: true, via: 'send-button' };
}

/** Serialized page-script invocation carrying its result type. */
export type PageScript<R> = string & { readonly __result?: R };

/** Serializes a page script call. Arguments are JSON-encoded; no string concatenation of untrusted text into code. */
export function scriptCall<A, R>(fn: (args: A) => R, args: A): PageScript<R> {
  return `(${fn.toString()})(${JSON.stringify(args)})` as PageScript<R>;
}
