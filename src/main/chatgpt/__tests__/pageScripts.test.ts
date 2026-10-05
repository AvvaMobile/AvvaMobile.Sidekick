// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SELECTORS,
  clickSendScript,
  focusComposerScript,
  pageStateScript,
  scriptCall,
} from '../pageScripts';

/** Mirrors the structure observed on chatgpt.com (Oct 2026, "octane" UI); see docs/ARCHITECTURE.md §6. */
function assistant(id: string, inner: string, complete = true): string {
  return `<li data-message-role="assistant" id="${id}" ${complete ? 'data-message-complete=""' : ''}>
    <div><div><div data-assistant-markdown="">${inner}</div></div></div></li>`;
}
function block(lang: string, text: string): string {
  return `<pre data-assistant-stream-block=""><code class="x1 language-${lang}">${text}</code>
    <span data-message-content-controls=""><button aria-label="Copy"></button></span></pre>`;
}
function page(...turns: string[]): void {
  document.body.innerHTML = `<main><ol aria-label="Conversation" data-conversation-transcript="">${turns.join('')}</ol>
    <form><textarea name="prompt" aria-label="Chat with ChatGPT"></textarea><button aria-label="Send message">send</button></form></main>`;
}
describe('composer and submit scripts', () => {
  it('detects composer, logged-out markers and generating state', () => {
    page(assistant('a1', '', false));
    const s = pageStateScript(SELECTORS);
    expect(s.composerFound).toBe(true);
    expect(s.generating).toBe(true);
  });

  it('refuses to insert over a user draft unless allowed', () => {
    page();
    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'draft';
    expect(focusComposerScript({ sel: SELECTORS, requireEmpty: true })).toMatchObject({ ok: false, code: 'composer_not_empty' });
    expect(focusComposerScript({ sel: SELECTORS, requireEmpty: false })).toMatchObject({ ok: true, kind: 'textarea', wasEmpty: false });
  });

  it('clicks only the identified send button', () => {
    page();
    let clicked = 0;
    document.querySelector('button')!.addEventListener('click', () => clicked++);
    expect(clickSendScript({ sel: SELECTORS })).toEqual({ ok: true, via: 'send-button' });
    expect(clicked).toBe(1);
    document.querySelector('button')!.setAttribute('disabled', '');
    expect(clickSendScript({ sel: SELECTORS })).toMatchObject({ ok: false, code: 'send_button_disabled' });
  });

  it('serializes calls with JSON-encoded args only', () => {
    const code = scriptCall(focusComposerScript, { sel: SELECTORS, requireEmpty: true });
    expect(code.startsWith('(')).toBe(true);
    expect(code).toContain(JSON.stringify({ sel: SELECTORS, requireEmpty: true }));
    // A serialized function must be self-contained: evaluating it in a fresh scope works.
    page();
    expect(new Function(`return ${code}`)()).toMatchObject({ ok: true });
  });
});

/** Logged-in 2026 UI (observed 2026-10-01): role-less turns, writing blocks, ProseMirror composer. */
function newUiPage(...turns: string[]): void {
  document.body.innerHTML = `<main>${turns.join('')}
    <form><div data-composer-input-variant="default"><div contenteditable="true" class="ProseMirror" data-composer-markdown="" aria-label="Ask ChatGPT"></div></div>
    <button aria-label="Send">send</button></form></main>`;
}
function newUser(id: string, text: string): string {
  return `<div data-chatgpt-search-unit-key="t:${id}:user" data-chatgpt-search-message-ids="${id}"><div data-content-search-unit-key="t:${id}:user"><div class="whitespace-pre-wrap">${text}</div></div></div>`;
}
function newAssistant(id: string, inner: string): string {
  return `<div data-content-search-unit-key="t:${id}:assistant" data-chatgpt-search-unit-key="t:${id}:assistant" data-chatgpt-search-message-ids="${id}">
    <h4 data-conversation-role="assistant">ChatGPT said:</h4>
    <div data-chatgpt-selection-message-id="${id}"><div data-markdown-text-style="assistant-message">${inner}</div></div></div>`;
}
function writingBlock(title: string, markdown: string): string {
  return `<div data-oai-writing-block-surface="" data-testid="chatgpt-writing-block" data-markdown-copy="rich-block" data-markdown-copy-text="${markdown.replace(/"/g, '&quot;')}">
    <header><button aria-label="Add to Library"><span>${title}</span></button><button aria-label="Copy"></button></header>
    <div data-markdown-copy-content="true"><div class="writing-block-editor"><div class="ProseMirror" contenteditable="true" aria-label="Start writing"><p>${markdown}</p></div></div></div></div>`;
}

/** 2026 UI fenced code block: no <pre>; header label is the language display name (observed 2026-10-01). */
function newCodeBlock(label: string, text: string): string {
  return `<div class="CodeBlock-x"><div data-markdown-copy="code-block" data-theme="light">
    <div data-markdown-copy="exclude"><div class="truncate">${label}</div><button aria-label="Copy"></button></div>
    <div><code class="whitespace-pre! block">${text}</code></div></div></div>`;
}

describe('2026 logged-in ChatGPT UI', () => {
  it('composer never resolves to a writing block editor', () => {
    newUiPage(newAssistant('m-1', writingBlock('Claude prompt', 'x')));
    expect(pageStateScript(SELECTORS).composerFound).toBe(true);
    const r = focusComposerScript({ sel: SELECTORS, requireEmpty: true });
    expect(r).toMatchObject({ ok: true, kind: 'contenteditable' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Ask ChatGPT');
  });

  it('clicks the new-UI Send button', () => {
    newUiPage();
    let clicked = 0;
    document.querySelector('button[aria-label="Send"]')!.addEventListener('click', () => clicked++);
    expect(clickSendScript({ sel: SELECTORS })).toEqual({ ok: true, via: 'send-button' });
    expect(clicked).toBe(1);
  });
});
