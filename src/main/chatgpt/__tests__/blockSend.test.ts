// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTORS, installBlockSendButtonsScript, scriptCall, setBlockSendStatusScript, takeBlockSendsScript, type TakeBlockSendsResult } from '../pageScripts';

type Guarded = Window & { __sidekickBlockSend?: unknown };
const install = () => new Function(`return ${scriptCall(installBlockSendButtonsScript, { sel: SELECTORS, maxChars: 100_000, trustedOnly: false })}`)() as { installed: boolean };
const take = () => new Function(`return ${scriptCall(takeBlockSendsScript, undefined)}`)() as TakeBlockSendsResult;
const setStatus = (id: string, state: 'sending' | 'started' | 'failed', detail = '') => new Function(`return ${scriptCall(setBlockSendStatusScript, { id, state, detail })}`)();

const codeBlock = (label: string, text: string) =>
  `<div data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>${label}</div><button aria-label="Copy"></button></div><div><code>${text}</code></div></div>`;
const writingBlock = (md: string) =>
  `<div data-oai-writing-block-surface="" data-testid="chatgpt-writing-block" data-markdown-copy-text="${md}"><header><button aria-label="Copy"></button></header><div data-markdown-copy-content="true">${md}</div></div>`;
const assistant = (id: string, inner: string) => `<div data-content-search-unit-key="t:${id}:assistant" data-chatgpt-search-message-ids="${id}">${inner}</div>`;

let listeners: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]>;
let copyClicks: number;
const buttons = () => Array.from(document.querySelectorAll<HTMLElement>('[data-sidekick-send]'));
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

beforeEach(() => {
  listeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
    listeners.push([type, fn, opts]);
    add(type, fn, opts);
  }) as typeof document.addEventListener);
  copyClicks = 0;
  document.body.innerHTML =
    assistant('m-1', `<p>one</p>${codeBlock('Plain text', 'FIRST prompt\nline 2')}`) +
    assistant('m-2', `${codeBlock('bash', 'echo second')}${writingBlock('THIRD writing block')}`);
  document.querySelectorAll('button[aria-label="Copy"]').forEach((b) => b.addEventListener('click', () => copyClicks++));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [t, fn, o] of listeners) document.removeEventListener(t, fn, o);
  delete (window as Guarded).__sidekickBlockSend;
});

describe('Send to Claude button on each block', () => {
  it('is injected right after every block\'s Copy button, once', () => {
    expect(install().installed).toBe(true);
    expect(install().installed).toBe(false);
    expect(buttons()).toHaveLength(3);
    for (const b of buttons()) expect(b.previousElementSibling?.getAttribute('aria-label')).toBe('Copy');
    expect(buttons()[0]!.textContent).toBe('Send to Claude');
  });

  it('each button queues exactly its own block text, never another block or an earlier click', () => {
    install();
    const [b1, b2, b3] = buttons();
    click(b1!);
    expect(take().requests.map((r) => r.text)).toEqual(['FIRST prompt\nline 2']);
    click(b2!);
    expect(take().requests.map((r) => r.text)).toEqual(['echo second']);
    click(b3!);
    const [r3] = take().requests;
    expect(r3!.text).toBe('THIRD writing block');
    expect(r3).toMatchObject({ messageId: 'm-2', blockIndex: 1 });
    expect(copyClicks).toBe(0);
  });

  it('reads the block at click time (edited/streamed text is what is sent)', () => {
    install();
    document.querySelectorAll('code')[0]!.textContent = 'FIRST prompt v2';
    click(buttons()[0]!);
    expect(take().requests[0]!.text).toBe('FIRST prompt v2');
  });

  it('refuses while ChatGPT is still writing and shows the failure on the button', () => {
    document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button"></button>');
    install();
    click(buttons()[0]!);
    expect(take().requests).toHaveLength(0);
    expect(buttons()[0]!.textContent).toBe('Send failed — Retry');
  });

  it('shows sending, started and failed on the clicked button; failed can be retried', () => {
    install();
    const b = buttons()[1]!;
    click(b);
    const id = take().requests[0]!.id;
    expect(b.textContent).toBe('Sending…');
    click(b); // double click while sending
    expect(take().requests).toHaveLength(0);
    setStatus(id, 'failed', 'Claude did not report receiving the prompt');
    expect(b.textContent).toBe('Send failed — Retry');
    expect(b.nextElementSibling?.textContent).toBe('Claude did not report receiving the prompt');
    click(b);
    const retry = take().requests;
    expect(retry).toHaveLength(1);
    expect(retry[0]!.text).toBe('echo second');
    expect(retry[0]!.id).not.toBe(id);
    expect(document.querySelector('[data-sidekick-send-detail]')).toBeNull();
    setStatus(retry[0]!.id, 'started');
    expect(b.textContent).toBe('Sent to Claude ✓');
  });

  it('adds buttons to blocks that appear later', async () => {
    install();
    document.body.insertAdjacentHTML('beforeend', assistant('m-3', codeBlock('Plain text', 'LATER')));
    await new Promise((r) => setTimeout(r, 300));
    expect(buttons()).toHaveLength(4);
  });
});
