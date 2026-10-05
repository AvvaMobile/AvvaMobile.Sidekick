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

// ---------- Pre-submit interception of Sidekick commands (D045) ----------

export interface InterceptedIntent {
  /** Unique per intercepted command (page-local counter + time). */
  id: string;
  text: string;
  detectedAt: string;
}

export interface IntentGuardArgs {
  sel: PageSelectors;
  /** Longest composer text still treated as a command; longer messages are normal chat. */
  maxChars: number;
  /** Production: only real user input (`isTrusted`) is intercepted; tests dispatch synthetic events. */
  trustedOnly: boolean;
}

/** `window.__sidekickIntentGuard` lives only in this script's isolated world; the page cannot see it. */
interface GuardState {
  queue: InterceptedIntent[];
  n: number;
  enabled: boolean;
}

/**
 * Installs capture-phase listeners (Enter, send-button click, form submit) that stop a composer message
 * which is an explicit "send this to Claude" command BEFORE ChatGPT's own handlers see it, clear the
 * composer and queue the command for the main process. Anything else is untouched; every failure path
 * lets the event through (fail-open). Idempotent per document.
 *
 * `isIntent` is `isSendToClaudeRequest` (self-contained); the call is built by `intentGuardCall`.
 */
export function installIntentGuardScript(args: IntentGuardArgs, isIntent: (text: string) => boolean): { ok: true; installed: boolean } {
  const w = window as unknown as { __sidekickIntentGuard?: GuardState };
  if (w.__sidekickIntentGuard) return { ok: true, installed: false };
  const state: GuardState = { queue: [], n: 0, enabled: true };
  w.__sidekickIntentGuard = state;
  const sel = args.sel;

  const composer = (): HTMLElement | null => (Array.from(document.querySelectorAll(sel.composer)).find((c) => !c.closest(sel.writingBlock)) ?? null) as HTMLElement | null;
  const read = (el: HTMLElement): string => (el.tagName === 'TEXTAREA' ? (el as HTMLTextAreaElement).value : (el.innerText ?? el.textContent ?? ''));

  /** Empties the composer through the editor's own input path so ChatGPT's state follows the DOM. */
  const clear = (el: HTMLElement): void => {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const ta = el as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, '');
      else ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    try {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } catch {
      // fall through to the manual path
    }
    if (read(el).trim()) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  /** True when the event was a Sidekick command and has been stopped. */
  const intercept = (e: Event): boolean => {
    try {
      if (!state.enabled || (args.trustedOnly && !e.isTrusted)) return false;
      const el = composer();
      if (!el) return false;
      const text = read(el).trim();
      if (!text || text.length > args.maxChars || !isIntent(text)) return false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      clear(el);
      state.queue.push({ id: `${Date.now().toString(36)}-${++state.n}`, text, detectedAt: new Date().toISOString() });
      return true;
    } catch {
      return false; // fail-open: ChatGPT proceeds as usual
    }
  };

  document.addEventListener(
    'keydown',
    (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== 'Enter' || k.shiftKey || k.altKey || k.isComposing || k.repeat) return;
      const el = composer();
      const target = e.target as Node | null;
      if (!el || !target || !(el === target || el.contains(target))) return;
      intercept(e);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as Element | null;
      if (t && typeof t.closest === 'function' && t.closest(sel.sendButton)) intercept(e);
    },
    true,
  );
  document.addEventListener('submit', (e) => void intercept(e), true);
  return { ok: true, installed: true };
}

export interface TakeIntentsResult {
  installed: boolean;
  intents: InterceptedIntent[];
}

/** Atomically takes (and clears) the queued commands; also tells the guard whether interception is currently wanted. */
export function takeInterceptedIntentsScript(args: { enabled: boolean }): TakeIntentsResult {
  const s = (window as unknown as { __sidekickIntentGuard?: GuardState }).__sidekickIntentGuard;
  if (!s) return { installed: false, intents: [] };
  s.enabled = args.enabled;
  return { installed: true, intents: s.queue.splice(0) };
}

// ---------- "Send to Claude" button on every prompt/code block ----------

export interface BlockSendRequest {
  /** Unique per click (page-local counter + time). */
  id: string;
  /** Exactly the text of the block the clicked button belongs to, read at click time. */
  text: string;
  messageId: string | null;
  blockIndex: number;
  clickedAt: string;
}

export interface BlockSendArgs {
  sel: PageSelectors;
  maxChars: number;
  /** Production: only real user clicks count; tests dispatch synthetic events. */
  trustedOnly: boolean;
}

export type BlockSendState = 'sending' | 'started' | 'failed';

interface BlockSendGuard {
  queue: BlockSendRequest[];
  n: number;
}

/**
 * Injects a "Send to Claude" button right after the Copy button of every prompt/code block of the
 * assistant messages (idempotent per document; re-scans on DOM changes). A click reads the text from the
 * very block that holds the clicked button and queues it; nothing else (no stored candidate, no other block)
 * is ever a source. Lives in the page's isolated world.
 */
export function installBlockSendButtonsScript(args: BlockSendArgs): { ok: true; installed: boolean } {
  const w = window as unknown as { __sidekickBlockSend?: BlockSendGuard };
  if (w.__sidekickBlockSend) return { ok: true, installed: false };
  const state: BlockSendGuard = { queue: [], n: 0 };
  w.__sidekickBlockSend = state;
  const sel = args.sel;
  const blockSel = 'pre, ' + sel.writingBlock + ', ' + sel.codeBlock;
  const ATTR = 'data-sidekick-send';
  const LABEL = 'Send to Claude';

  const isWritingBlock = (el: Element): boolean => el.matches(sel.writingBlock);

  /** The outermost block (a <pre>/<code> inside a code-block container or writing block is the same block). */
  const outermostBlock = (from: Element): Element | null => {
    let cur = from.closest(blockSel);
    while (cur && cur.parentElement?.closest(blockSel)) cur = cur.parentElement.closest(blockSel);
    return cur;
  };

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

  const messageOf = (block: Element): Element | null => block.closest(sel.assistantMessage);
  const messageIdOf = (msg: Element): string | null =>
    msg.getAttribute('data-message-id') ??
    msg.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id') ??
    msg.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/)[0] ??
    (msg.id || null);

  const detailEl = (btn: HTMLElement): HTMLElement | null => (btn.nextElementSibling?.hasAttribute(ATTR + '-detail') ? (btn.nextElementSibling as HTMLElement) : null);
  const setLabel = (btn: HTMLElement, text: string, st: string, detail?: string): void => {
    btn.textContent = text;
    btn.setAttribute(ATTR, st);
    btn.setAttribute('aria-label', text);
    btn.title = detail ?? '';
    btn.style.color = st === 'failed' ? '#d92d20' : '';
    let d = detailEl(btn);
    if (detail && st === 'failed') {
      if (!d) {
        d = document.createElement('span');
        d.setAttribute(ATTR + '-detail', '');
        d.style.cssText = 'font-size:12px;color:#d92d20;margin-left:6px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:center';
        btn.insertAdjacentElement('afterend', d);
      }
      d.textContent = detail;
      d.title = detail;
    } else d?.remove();
  };

  const fail = (btn: HTMLElement, detail: string): void => setLabel(btn, 'Send failed — Retry', 'failed', detail);

  const makeButton = (copy: HTMLElement): HTMLElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = copy.className;
    btn.style.cssText = 'width:auto;padding:0 8px;font-size:12px;white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center';
    setLabel(btn, LABEL, 'idle');
    return btn;
  };

  const inject = (): void => {
    for (const msg of Array.from(document.querySelectorAll(sel.assistantMessage))) {
      for (const block of Array.from(msg.querySelectorAll(blockSel))) {
        if (block.parentElement?.closest(blockSel) || block.querySelector('[' + ATTR + ']')) continue;
        const copy = block.querySelector('button[aria-label="Copy"]') as HTMLElement | null;
        if (!copy || copy.hasAttribute(ATTR)) continue;
        copy.insertAdjacentElement('afterend', makeButton(copy));
      }
    }
  };

  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as Element | null;
      const btn = t && typeof t.closest === 'function' ? (t.closest('[' + ATTR + ']') as HTMLElement | null) : null;
      if (!btn || btn.hasAttribute(ATTR + '-detail')) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (args.trustedOnly && !e.isTrusted) return;
      if (btn.getAttribute(ATTR) === 'sending') return;
      try {
        const block = outermostBlock(btn);
        const msg = block ? messageOf(block) : null;
        if (!block || !msg) return fail(btn, 'Could not find this block');
        if (document.querySelector(sel.stopButton) || document.querySelector(sel.incompleteAssistant)) return fail(btn, 'ChatGPT is still writing — try again when it finishes');
        const text = blockText(block);
        if (!text.trim()) return fail(btn, 'This block is empty');
        if (text.length > args.maxChars) return fail(btn, 'This block is too large to send');
        const blocks = Array.from(msg.querySelectorAll(blockSel)).filter((b) => !b.parentElement?.closest(blockSel));
        const id = `${Date.now().toString(36)}-${++state.n}`;
        btn.setAttribute(ATTR + '-id', id);
        setLabel(btn, 'Sending…', 'sending');
        state.queue.push({ id, text, messageId: messageIdOf(msg), blockIndex: blocks.indexOf(block), clickedAt: new Date().toISOString() });
      } catch {
        fail(btn, 'Could not read this block');
      }
    },
    true,
  );

  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try {
        inject();
      } catch {
        // never break the page
      }
    }, 150);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  inject();
  return { ok: true, installed: true };
}

export interface TakeBlockSendsResult {
  installed: boolean;
  requests: BlockSendRequest[];
}

/** Atomically takes (and clears) the queued block sends. `installed: false` means the page was reloaded (reinstall). */
export function takeBlockSendsScript(): TakeBlockSendsResult {
  const s = (window as unknown as { __sidekickBlockSend?: BlockSendGuard }).__sidekickBlockSend;
  if (!s) return { installed: false, requests: [] };
  return { installed: true, requests: s.queue.splice(0) };
}

/** Shows the outcome of one click on its own button: sending / started (Claude confirmed receipt) / failed (+ reason, Retry). */
export function setBlockSendStatusScript(args: { id: string; state: BlockSendState; detail: string }): { found: boolean } {
  const btn = document.querySelector('[data-sidekick-send-id="' + args.id + '"]') as HTMLElement | null;
  if (!btn) return { found: false };
  const ATTR = 'data-sidekick-send';
  const next = btn.nextElementSibling;
  if (args.state === 'failed') {
    btn.textContent = 'Send failed — Retry';
    btn.setAttribute(ATTR, 'failed');
    btn.title = args.detail;
    btn.style.color = '#d92d20';
    let d = next?.hasAttribute(ATTR + '-detail') ? (next as HTMLElement) : null;
    if (!d) {
      d = document.createElement('span');
      d.setAttribute(ATTR + '-detail', '');
      d.style.cssText = 'font-size:12px;color:#d92d20;margin-left:6px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:center';
      btn.insertAdjacentElement('afterend', d);
    }
    d.textContent = args.detail;
    d.title = args.detail;
    return { found: true };
  }
  if (next?.hasAttribute(ATTR + '-detail')) next.remove();
  btn.style.color = '';
  btn.title = args.detail;
  if (args.state === 'sending') {
    btn.textContent = 'Sending…';
    btn.setAttribute(ATTR, 'sending');
  } else {
    btn.textContent = 'Sent to Claude ✓';
    btn.setAttribute(ATTR, 'started');
    setTimeout(() => {
      if (btn.getAttribute(ATTR) === 'started') {
        btn.textContent = 'Send to Claude';
        btn.setAttribute(ATTR, 'idle');
        btn.title = '';
      }
    }, 8000);
  }
  return { found: true };
}

/** Serialized install call: the guard plus the self-contained intent matcher, args JSON-encoded. */
export function intentGuardCall(args: IntentGuardArgs, isIntent: (text: string) => boolean): PageScript<{ ok: true; installed: boolean }> {
  return `(${installIntentGuardScript.toString()})(${JSON.stringify(args)}, ${isIntent.toString()})` as PageScript<{ ok: true; installed: boolean }>;
}

/** Serialized page-script invocation carrying its result type. */
export type PageScript<R> = string & { readonly __result?: R };

/** Serializes a page script call. Arguments are JSON-encoded; no string concatenation of untrusted text into code. */
export function scriptCall<A, R>(fn: (args: A) => R, args: A): PageScript<R> {
  return `(${fn.toString()})(${JSON.stringify(args)})` as PageScript<R>;
}
