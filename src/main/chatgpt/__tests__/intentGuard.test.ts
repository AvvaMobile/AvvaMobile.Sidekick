// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSendToClaudeRequest } from '../../../domain/handoff/autoSend';
import { SELECTORS, intentGuardCall, scriptCall, takeInterceptedIntentsScript, type TakeIntentsResult } from '../pageScripts';

type Guarded = Window & { __sidekickIntentGuard?: unknown };
const install = (trustedOnly = false) => new Function(`return ${intentGuardCall({ sel: SELECTORS, maxChars: 240, trustedOnly }, isSendToClaudeRequest)}`)() as { ok: true; installed: boolean };
const take = (enabled = true) => new Function(`return ${scriptCall(takeInterceptedIntentsScript, { enabled })}`)() as TakeIntentsResult;

const COMPOSER_HTML = '<form><div id="prompt-textarea" contenteditable="true" data-composer-markdown></div><button data-testid="send-button" type="button">Send</button></form>';
let listeners: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]>;
/** What ChatGPT's own handlers would do: a normal message reaching them is a submit. */
let chatgptSubmits: number;

const composer = () => document.querySelector('#prompt-textarea') as HTMLElement;
const type = (text: string) => {
  composer().textContent = text;
};
function pressEnter(opts: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts });
  composer().dispatchEvent(e);
  return e;
}
function clickSend() {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  document.querySelector('[data-testid="send-button"]')!.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = COMPOSER_HTML;
  listeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    listeners.push([type, fn, opts]);
    add(type, fn, opts);
  }) as typeof document.addEventListener);
  chatgptSubmits = 0;
  // ChatGPT's own (bubble-phase) submit handlers.
  composer().addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') chatgptSubmits++;
  });
  document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => chatgptSubmits++);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [t, fn, o] of listeners) document.removeEventListener(t, fn, o);
  delete (window as Guarded).__sidekickIntentGuard;
});

describe('pre-submit command guard (D045)', () => {
  it('Enter on "şimdi bunu claude gönder": ChatGPT never sees it, the command is queued, the composer is cleared', () => {
    expect(install().installed).toBe(true);
    type('şimdi bunu claude gönder');
    const e = pressEnter();
    expect(e.defaultPrevented).toBe(true);
    expect(chatgptSubmits).toBe(0);
    expect(composer().textContent).toBe('');
    const r = take();
    expect(r.installed).toBe(true);
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]).toMatchObject({ text: 'şimdi bunu claude gönder', id: expect.any(String) });
  });

  it('Send button click behaves the same', () => {
    install();
    type('şimdi bunu claude gönder');
    const e = clickSend();
    expect(e.defaultPrevented).toBe(true);
    expect(chatgptSubmits).toBe(0);
    expect(composer().textContent).toBe('');
    expect(take().intents).toHaveLength(1);
  });

  it('English "send this to Claude" is intercepted too', () => {
    install();
    type('send this to Claude');
    expect(pressEnter().defaultPrevented).toBe(true);
    expect(take().intents[0]!.text).toBe('send this to Claude');
  });

  it('a form submit event is stopped as well', () => {
    install();
    type('bunu Claude\'a gönder');
    const e = new Event('submit', { bubbles: true, cancelable: true });
    document.querySelector('form')!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(take().intents).toHaveLength(1);
  });

  it('a textarea composer is supported and cleared', () => {
    document.body.innerHTML = '<form><textarea name="prompt"></textarea><button data-testid="send-button" type="button">Send</button></form>';
    install();
    const ta = document.querySelector('textarea')!;
    ta.value = 'send this to Claude';
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('');
    expect(take().intents).toHaveLength(1);
  });

  it.each(['Claude hakkında ne düşünüyorsun?', "Claude'a gönderme", 'Explain how Claude Code hooks work', 'Merhaba'])('normal message %j is not touched', (text) => {
    install();
    type(text);
    const e = pressEnter();
    expect(e.defaultPrevented).toBe(false);
    expect(chatgptSubmits).toBe(1); // ChatGPT's handler ran as usual
    expect(composer().textContent).toBe(text);
    expect(clickSend().defaultPrevented).toBe(false);
    expect(take().intents).toEqual([]);
  });

  it('a long message that merely contains the phrase is chat, not a command', () => {
    install();
    type(`${'Lorem ipsum dolor sit amet. '.repeat(12)} send this to Claude`);
    expect(pressEnter().defaultPrevented).toBe(false);
    expect(take().intents).toEqual([]);
  });

  it('Shift+Enter (new line) and IME composition are ignored; an empty composer is ignored', () => {
    install();
    type('send this to Claude');
    expect(pressEnter({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(pressEnter({ isComposing: true }).defaultPrevented).toBe(false);
    type('');
    expect(pressEnter().defaultPrevented).toBe(false);
    expect(take().intents).toEqual([]);
  });

  it('real input only: untrusted (script-made) events are ignored in production mode', () => {
    install(true);
    type('send this to Claude');
    expect(pressEnter().defaultPrevented).toBe(false); // happy-dom events are not trusted
    expect(take().intents).toEqual([]);
  });

  it('installing twice is idempotent: one listener set, one intent per command', () => {
    expect(install().installed).toBe(true);
    expect(install().installed).toBe(false);
    type('send this to Claude');
    pressEnter();
    expect(take().intents).toHaveLength(1);
  });

  it('keeps working after an SPA navigation (the DOM is replaced, listeners live on the document)', () => {
    install();
    history.pushState({}, '', '/c/other-conversation');
    document.body.innerHTML = COMPOSER_HTML;
    type('şimdi bunu claude gönder');
    expect(pressEnter().defaultPrevented).toBe(true);
    expect(take().intents).toHaveLength(1);
  });

  it('take is atomic: the queue is emptied, and a reload (no guard) reports installed:false', () => {
    install();
    type('send this to Claude');
    pressEnter();
    expect(take().intents).toHaveLength(1);
    expect(take().intents).toEqual([]);
    delete (window as Guarded).__sidekickIntentGuard;
    expect(take()).toEqual({ installed: false, intents: [] });
  });

  it('when auto-send is turned off nothing is intercepted (fail-open)', () => {
    install();
    take(false);
    type('send this to Claude');
    expect(pressEnter().defaultPrevented).toBe(false);
    expect(chatgptSubmits).toBe(1);
    take(true);
    expect(pressEnter().defaultPrevented).toBe(true);
  });

  it('fails open when the page breaks: a throwing matcher never blocks a message', () => {
    const code = intentGuardCall({ sel: SELECTORS, maxChars: 240, trustedOnly: false }, (() => {
      throw new Error('boom');
    }) as unknown as typeof isSendToClaudeRequest);
    new Function(`return ${code}`)();
    type('anything');
    expect(pressEnter().defaultPrevented).toBe(false);
    expect(chatgptSubmits).toBe(1);
  });
});
