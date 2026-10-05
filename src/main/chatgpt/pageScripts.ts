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
 * very block that holds the clicked button and queues it; nothing else (no other block, no stored text)
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

/** Serialized page-script invocation carrying its result type. */
export type PageScript<R> = string & { readonly __result?: R };

/** Serializes a page script call. Arguments are JSON-encoded; no string concatenation of untrusted text into code. */
export function scriptCall<A, R>(fn: (args: A) => R, args: A): PageScript<R> {
  return `(${fn.toString()})(${JSON.stringify(args)})` as PageScript<R>;
}
