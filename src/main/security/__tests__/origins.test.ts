import { describe, expect, it } from 'vitest';
import {
  isAllowedTopLevelUrl,
  isAuthUrl,
  isChatGptAppOrigin,
  isChatGptAppUrl,
  isChatGptConversationUrl,
  isSafeExternalUrl,
  sameConversationUrl,
} from '../origins';

describe('origin policy', () => {
  it('accepts only https ChatGPT app hosts', () => {
    expect(isChatGptAppUrl('https://chatgpt.com/')).toBe(true);
    expect(isChatGptAppUrl('https://chat.openai.com/c/abc')).toBe(true);
    expect(isChatGptAppUrl('http://chatgpt.com/')).toBe(false);
    expect(isChatGptAppUrl('https://chatgpt.com.evil.com/')).toBe(false);
    expect(isChatGptAppUrl('https://evil.com/?chatgpt.com')).toBe(false);
    expect(isChatGptAppUrl('https://sub.chatgpt.com/')).toBe(false);
    expect(isChatGptAppUrl('https://chatgpt.com:8443/')).toBe(false);
    expect(isChatGptAppUrl('https://user:pw@chatgpt.com/')).toBe(false);
    expect(isChatGptAppUrl('javascript:alert(1)')).toBe(false);
    expect(isChatGptAppUrl('not a url')).toBe(false);
  });

  it('matches permission-handler origins', () => {
    expect(isChatGptAppOrigin('https://chatgpt.com')).toBe(true);
    expect(isChatGptAppOrigin('https://accounts.google.com')).toBe(false);
    expect(isChatGptAppOrigin('file://')).toBe(false);
  });

  it('allows auth hosts for navigation but not as app origins', () => {
    for (const u of ['https://auth.openai.com/log-in', 'https://accounts.google.com/o/oauth2', 'https://appleid.apple.com/auth']) {
      expect(isAuthUrl(u)).toBe(true);
      expect(isAllowedTopLevelUrl(u)).toBe(true);
      expect(isChatGptAppUrl(u)).toBe(false);
    }
    expect(isAllowedTopLevelUrl('https://example.com/')).toBe(false);
    expect(isAllowedTopLevelUrl('file:///etc/passwd')).toBe(false);
  });

  it("allows Google's sign-in cookie-sync redirect hosts, nothing broader", () => {
    for (const u of [
      'https://accounts.youtube.com/accounts/SetSID?ssdc=1',
      'https://accounts.google.com.tr/accounts/SetSID',
      'https://accounts.google.de/accounts/SetSID',
      'https://accounts.google.co.uk/accounts/SetSID',
    ]) {
      expect(isAllowedTopLevelUrl(u)).toBe(true);
      expect(isChatGptAppUrl(u)).toBe(false);
    }
    for (const u of [
      'https://www.youtube.com/',
      'https://youtube.com/accounts/SetSID',
      'https://accounts.google.evil.com/',
      'https://accounts.google.com.evil.io/',
      'https://xaccounts.google.de/',
      'http://accounts.youtube.com/accounts/SetSID',
    ])
      expect(isAllowedTopLevelUrl(u)).toBe(false);
  });

  it('validates persisted conversation URLs', () => {
    expect(isChatGptConversationUrl('https://chatgpt.com/c/6abe1b2f-d2dc-83ea')).toBe(true);
    expect(isChatGptConversationUrl('https://chatgpt.com/uc/6abe1b2f-d2dc-83ea')).toBe(true);
    expect(isChatGptConversationUrl('https://chatgpt.com/g/g-abc/c/123')).toBe(true);
    expect(isChatGptConversationUrl('https://chatgpt.com/')).toBe(false);
    expect(isChatGptConversationUrl('https://chatgpt.com/c/../../x')).toBe(false);
    expect(isChatGptConversationUrl('https://evil.com/c/123')).toBe(false);
  });

  it('only hands http(s) links to the OS browser', () => {
    expect(isSafeExternalUrl('https://example.com/a')).toBe(true);
    expect(isSafeExternalUrl('file:///Applications/Calculator.app')).toBe(false);
    expect(isSafeExternalUrl('smb://host/share')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('sameConversationUrl', () => {
  it('compares the conversation (origin + path), ignoring query, fragment and a trailing slash', () => {
    expect(sameConversationUrl('https://chatgpt.com/c/abc?model=x#y', 'https://chatgpt.com/c/abc/')).toBe(true);
    expect(sameConversationUrl('https://chatgpt.com/c/abc', 'https://chatgpt.com/c/def')).toBe(false);
    expect(sameConversationUrl('https://chatgpt.com/g/g-1/c/abc', 'https://chatgpt.com/c/abc')).toBe(false);
  });

  it('never matches an unknown or non-conversation URL', () => {
    expect(sameConversationUrl(null, 'https://chatgpt.com/c/abc')).toBe(false);
    expect(sameConversationUrl('https://chatgpt.com/', 'https://chatgpt.com/')).toBe(false);
    expect(sameConversationUrl('https://evil.example/c/abc', 'https://evil.example/c/abc')).toBe(false);
  });
});
