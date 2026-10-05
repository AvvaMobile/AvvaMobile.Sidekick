import { describe, expect, it } from 'vitest';
import { isSendToClaudeRequest, normalizeRequest } from '../autoSend';

describe('normalizeRequest', () => {
  it('lowercases Turkish-aware, folds accents, drops apostrophes and collapses whitespace', () => {
    expect(normalizeRequest("Bu PROMPTU  Claude'a GÖNDER!")).toBe('bu promptu claudea gonder');
    expect(normalizeRequest('İLET ILET ılet')).toBe('ilet ilet ilet');
    expect(normalizeRequest('Klod’a `ilet` ´şimdi´')).toBe('kloda ilet simdi');
    expect(normalizeRequest('"send"\n\tit…to  Claude?')).toBe('send it to claude');
    expect(normalizeRequest('İlet'.toLowerCase())).toBe('ilet');
  });
});

describe('isSendToClaudeRequest', () => {
  const yes = [
    "bu promptu Claude'a gönder",
    "Claude'a gönder",
    'claudea yolla',
    "Klod'a ilet",
    'Klod’a ilet',
    "Claude'a at",
    'promptu claude ye gönder',
    "CLAUDE'A GÖNDER",
    "Tamam, bunu Claude'a gönderir misin?",
    "Claude'a bu promptu yolla lütfen",
    "gönder Claude'a",
    "Cloud'a aktar",
    'klota at',
    'send this to Claude',
    'send it to claude',
    'send the prompt to Claude',
    'pass this to Claude',
    'Send it over to Claude.',
    'Looks good, please forward the prompt to Claude!',
    'Can you send this to Claude?',
  ];
  const no = [
    "Claude'a göndermeden önce bir düşünelim",
    "Claude'a gönderme",
    "don't send this to Claude",
    'don’t send this to Claude',
    'do not send to claude yet',
    'Claude ne yapar?',
    "bunu Claude'a göndereceğiz ama önce planı yaz",
    "Claude'a gönder ama önce testleri ekle",
    "Claude'a gönderelim mi?",
    "henüz Claude'a gönder deme",
    'should we send this to Claude?',
    'send this to Claude later',
    'if it looks fine, send it to Claude',
    'Claude gönderir', // statement, not a request
    'Claude bunu iyi yapar, prompt yaz',
    'write a prompt for Claude',
    'look at Claude output',
    'send me the plan',
    'I sent it to Claude yesterday', // past tense
    '',
  ];
  it.each(yes)('matches: %s', (t) => expect(isSendToClaudeRequest(t)).toBe(true));
  it.each(no)('does not match: %s', (t) => expect(isSendToClaudeRequest(t)).toBe(false));

  it('a long message counts only when the request itself is not negated nearby', () => {
    const long = 'Burada uzun bir açıklama var. Planı oku, adımları kontrol et ve testleri düşün. Her şey tamam. Şimdi bu promptu Claude\'a gönder.';
    expect(isSendToClaudeRequest(long)).toBe(true);
  });
});

describe('isSendToClaudeRequest is self-contained (it runs inside the ChatGPT page, D045)', () => {
  const standalone = new Function(`return ${isSendToClaudeRequest.toString()}`)() as typeof isSendToClaudeRequest;
  const corpus = [
    "şimdi bunu claude gönder", "bunu Claude'a gönder", 'send this to Claude', 'Claude hakkında ne düşünüyorsun?', "Claude'a gönderme",
    'claude a atar misin', 'gönder claude ya', 'do not send this to claude', 'hello', '',
  ];
  it('gives the same answers when evaluated without any module scope', () => {
    for (const text of corpus) expect(standalone(text), text).toBe(isSendToClaudeRequest(text));
    expect(standalone('send this to Claude')).toBe(true);
    expect(standalone("Claude'a gönderme")).toBe(false);
  });
});

