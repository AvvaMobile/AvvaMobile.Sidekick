// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { SELECTORS, latestMessageTextScript } from '../pageScripts';

const latestUser = () => latestMessageTextScript({ selector: SELECTORS.userMessage, maxChars: 2000 });

describe('latestMessageTextScript message id', () => {
  it('uses data-message-id when present', () => {
    document.body.innerHTML = '<div data-message-author-role="user" data-message-id="m-7">send it to Claude</div>';
    expect(latestUser()).toMatchObject({ ok: true, messageId: 'm-7' });
  });

  it('falls back to the stable content-search unit key (2026 UI has no message id)', () => {
    document.body.innerHTML =
      '<div data-chatgpt-search-unit-key="t:u1:user"><div data-content-search-unit-key="t:u1:user"><div class="whitespace-pre-wrap">one</div></div></div>' +
      '<div data-chatgpt-search-unit-key="t:u2:user"><div data-content-search-unit-key="t:u2:user"><div class="whitespace-pre-wrap">two</div></div></div>';
    expect(latestUser()).toMatchObject({ ok: true, text: 'two', messageId: 't:u2:user' });
  });

  it('reports no id when none can be derived', () => {
    document.body.innerHTML = '<li data-message-role="user">hi</li>';
    expect(latestUser()).toMatchObject({ ok: true, messageId: null });
  });
});
