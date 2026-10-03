// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_PROMPT_LANGUAGE,
  SELECTORS,
  clickSendScript,
  focusComposerScript,
  latestClaudePromptBlockScript,
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
const capture = (maxChars = 100_000) => latestClaudePromptBlockScript({ sel: SELECTORS, language: CLAUDE_PROMPT_LANGUAGE, maxChars });

describe('latestClaudePromptBlockScript', () => {
  beforeEach(() => page());

  it('returns only the designated block text of the latest assistant message', () => {
    page(
      `<li data-message-role="user" id="u1">make a plan</li>`,
      assistant('a1', `<p>Here is the plan</p>${block('ts', 'const x = 1;')}${block('claude-prompt', 'Implement X\nwith tests')}<p>Good luck</p>`),
    );
    const r = capture();
    expect(r).toMatchObject({ ok: true, text: 'Implement X\nwith tests', messageId: 'a1', messagesBack: 0, truncated: false });
  });

  it('picks the newest prompt block across messages and ignores newer non-designated code', () => {
    page(
      assistant('a1', block('claude-prompt', 'OLD')),
      assistant('a2', block('claude-prompt', 'NEW')),
      assistant('a3', `<p>discussion</p>${block('bash', 'rm -rf /tmp/x')}`),
    );
    expect(capture()).toMatchObject({ ok: true, text: 'NEW', messageId: 'a2', messagesBack: 1 });
  });

  it('takes the last designated block within one message', () => {
    page(assistant('a1', block('claude-prompt', 'first') + block('claude-prompt', 'second')));
    expect(capture()).toMatchObject({ ok: true, text: 'second', blockIndex: 1 });
  });

  it('never returns code in a programming language', () => {
    page(assistant('a1', block('python', 'print(1)') + block('bash', 'ls')));
    expect(capture()).toMatchObject({ ok: false, code: 'no_prompt_block' });
  });

  it('refuses while a response is still streaming', () => {
    page(assistant('a1', block('claude-prompt', 'partial'), false));
    expect(capture()).toMatchObject({ ok: false, code: 'still_generating' });
  });

  it('reports no assistant messages', () => {
    page();
    expect(capture()).toMatchObject({ ok: false, code: 'no_assistant_messages' });
  });

  it('truncates to maxChars and flags it', () => {
    page(assistant('a1', block('claude-prompt', 'x'.repeat(50))));
    expect(capture(10)).toMatchObject({ ok: true, text: 'x'.repeat(10), truncated: true });
  });

  it('preserves the text verbatim (no HTML)', () => {
    page(assistant('a1', block('claude-prompt', '&lt;div&gt; a &amp;&amp; b')));
    expect(capture()).toMatchObject({ ok: true, text: '<div> a && b' });
  });
});

describe('composer and submit scripts', () => {
  it('detects composer, logged-out markers and generating state', () => {
    page(assistant('a1', '', false));
    const s = pageStateScript(SELECTORS);
    expect(s.composerFound).toBe(true);
    expect(s.generating).toBe(true);
    expect(s.assistantMessageCount).toBe(1);
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
  it('captures a new-style claude-prompt code block', () => {
    newUiPage(newAssistant('m-3', `<p>Here</p>${newCodeBlock('claude-prompt', 'Tagged prompt')}`));
    expect(capture()).toMatchObject({ ok: true, text: 'Tagged prompt', designation: 'tagged' });
  });

  it('falls back to the plain-text block of a reply that hands it to Claude', () => {
    newUiPage(newAssistant('m-4', `<p>Evet, isteyelim.</p><p>Claude’a bunu ver:</p>${newCodeBlock('Plain text', 'Acme için rapor çıkar.\n- git fetch')}`));
    expect(capture()).toMatchObject({ ok: true, text: 'Acme için rapor çıkar.\n- git fetch', messageId: 'm-4', designation: 'boxed' });
  });

  it('never uses code in a programming language', () => {
    newUiPage(newAssistant('m-5', `<p>Claude'a şunu çalıştırt:</p>${newCodeBlock('Bash', 'rm -rf build')}${newCodeBlock('TypeScript', 'const x = 1')}`));
    expect(capture()).toMatchObject({ ok: false, code: 'no_prompt_block' });
  });

  it('a plain-text box is used without any mention of Claude', () => {
    newUiPage(newAssistant('m-6', `<p>Adaş,</p>${newCodeBlock('Plain text', 'just text')}`));
    expect(capture()).toMatchObject({ ok: true, text: 'just text', designation: 'boxed' });
  });

  it('the newest reply with a box wins; a later reply without a box keeps the earlier prompt', () => {
    newUiPage(newAssistant('m-8', newCodeBlock('Plain text', 'older')), newAssistant('m-9', writingBlock('Plan', 'newer')), newAssistant('m-10', '<p>no box here</p>'));
    expect(capture()).toMatchObject({ ok: true, text: 'newer', messageId: 'm-9', messagesBack: 1 });
  });

  it('a tagged block wins over a plain block in the same reply', () => {
    newUiPage(newAssistant('m-7', `<p>Claude için:</p>${newCodeBlock('claude-prompt', 'THE PROMPT')}${newCodeBlock('Plain text', 'notes')}`));
    expect(capture()).toMatchObject({ ok: true, text: 'THE PROMPT', designation: 'tagged' });
  });

  it('captures a writing block titled for Claude, using its markdown text', () => {
    newUiPage(newUser('u1', 'claude için prompt yaz'), newAssistant('m-1', `<p>Here you go</p>${writingBlock('Claude test prompt', 'Line one\n\nCLAUDE_OK')}<p>bye</p>`));
    expect(capture()).toMatchObject({ ok: true, text: 'Line one\n\nCLAUDE_OK', messageId: 'm-1' });
  });

  it('uses any titled writing block (D032), never user turns', () => {
    newUiPage(newAssistant('m-1', writingBlock('Workspace Repository Sync and Status Audit Prompt', '```text\nAudit the repo\nstep 2\n```')), newUser('u2', '```claude-prompt\nnot from assistant\n```'));
    expect(capture()).toMatchObject({ ok: true, text: 'Audit the repo\nstep 2', messageId: 'm-1', designation: 'boxed' });
  });

  it('still captures claude-prompt fenced code in the new UI', () => {
    newUiPage(newAssistant('m-2', block('claude-prompt', 'Fenced prompt')));
    expect(capture()).toMatchObject({ ok: true, text: 'Fenced prompt', messageId: 'm-2' });
  });

  it('composer never resolves to a writing block editor', () => {
    newUiPage(newAssistant('m-1', writingBlock('Claude prompt', 'x')));
    expect(pageStateScript(SELECTORS).composerFound).toBe(true);
    const r = focusComposerScript({ sel: SELECTORS, requireEmpty: true });
    expect(r).toMatchObject({ ok: true, kind: 'contenteditable' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Ask ChatGPT');
    expect(pageStateScript(SELECTORS).assistantMessageCount).toBe(1);
  });

  it('clicks the new-UI Send button', () => {
    newUiPage();
    let clicked = 0;
    document.querySelector('button[aria-label="Send"]')!.addEventListener('click', () => clicked++);
    expect(clickSendScript({ sel: SELECTORS })).toEqual({ ok: true, via: 'send-button' });
    expect(clicked).toBe(1);
  });
});
