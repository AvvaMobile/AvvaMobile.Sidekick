/**
 * Detects an explicit "send this to Claude" request in the user's own ChatGPT message (D034).
 * Deliberately conservative: false negatives are fine (the user still has the button), false
 * positives are not.
 */

/** Countdown before an auto-send fires (the user can cancel it). */
export const AUTO_SEND_DELAY_MS = 3_000;

/**
 * Turkish-aware lowercase, accents folded to ASCII, apostrophes removed, other punctuation to spaces.
 * Same normalization as inside `isSendToClaudeRequest` (which must stay self-contained, see there).
 */
export function normalizeRequest(text: string): string {
  return text
    .toLocaleLowerCase('tr')
    .replace(/i̇/g, 'i') // "İ".toLowerCase() outside the tr locale
    .replace(/[ıİ]/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/[’‘`´']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when the message explicitly asks for the prompt to be sent to Claude now.
 *
 * SELF-CONTAINED ON PURPOSE: this function is serialized with Function#toString() into the ChatGPT page
 * (isolated world) to decide synchronously, before ChatGPT submits a message (D045). It must not
 * reference anything outside its own body (autoSend.test.ts evaluates its source in isolation).
 */
export function isSendToClaudeRequest(text: string): boolean {
  /** "Claude" and its common voice-transcription variants, optionally with a Turkish dative suffix glued on. */
  const CLAUDE = /^(claude|klod|clod|cloud|clode|klot)(a|e|ya|ye|ea)?$/;
  /** Turkish imperatives that mean "send / forward" (accent-folded). */
  const TR_VERBS = new Set([
    'gonder', 'gonderin', 'gonderiver', 'gonderelim', 'gondersene',
    'yolla', 'yollayin', 'yollayiver', 'yollayalim', 'yollasana',
    'ilet', 'iletin', 'iletiver', 'iletelim',
    'at', 'atin', 'ativer', 'atalim', 'atsana',
    'aktar', 'aktarin', 'aktaralim',
  ]);
  /** Aorist / ability forms that are a request only when followed by a question particle ("gönderir misin"). */
  const TR_VERBS_Q = new Set(['gonderir', 'gonderebilir', 'yollar', 'yollayabilir', 'iletir', 'iletebilir', 'atar', 'atabilir', 'aktarir', 'aktarabilir']);
  const TR_Q = new Set(['misin', 'misiniz', 'musun', 'musunuz', 'msn']);
  /** Verbs that may also come first ("gönder Claude'a"). `at` is excluded: it is an English preposition too. */
  const TR_VERBS_BEFORE = new Set(['gonder', 'gonderin', 'yolla', 'yollayin', 'ilet', 'iletin', 'aktar', 'aktarin']);
  const EN_VERBS = new Set(['send', 'pass', 'forward', 'hand', 'give', 'submit', 'push']);
  /** Negation, deferral and condition words: any of them near the phrase cancels the match. */
  const NEGATIONS = new Set([
    // Turkish (accent-folded)
    'gonderme', 'gondermeden', 'gondermeyin', 'gondermesin', 'gondermeyelim', 'yollama', 'yollamadan', 'iletme', 'iletmeden', 'atma', 'atmadan',
    'aktarma', 'aktarmadan', 'henuz', 'sonra', 'once', 'ama', 'fakat', 'ancak', 'degil', 'yok', 'mi', 'miyim', 'miyiz', 'eger', 'dur', 'bekle',
    'istemiyorum', 'neden', 'nasil',
    // English (apostrophes already removed)
    'dont', 'not', 'never', 'yet', 'later', 'before', 'after', 'if', 'when', 'whether', 'until', 'wait', 'should', 'shouldnt', 'cant', 'wont',
    'doesnt', 'didnt', 'no',
  ]);
  const WINDOW = 6;

  const t = (text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/i̇/g, 'i')
    .replace(/[ıİ]/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/[’‘`´']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  /** Candidate phrase spans [first token, last token]. */
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < t.length; i++) {
    if (!CLAUDE.test(t[i]!)) continue;
    // Turkish, Claude first: "claude'a (bu promptu) gönder", "claude ye gönder", "claude'a atar mısın".
    for (let j = i + 1; j <= i + 4 && j < t.length; j++) {
      const w = t[j]!;
      if (TR_VERBS.has(w)) spans.push([i, j]);
      else if (TR_VERBS_Q.has(w) && TR_Q.has(t[j + 1] ?? '')) spans.push([i, j + 1]);
    }
    // Turkish, verb first: "gönder claude'a".
    for (let j = Math.max(0, i - 2); j < i; j++) if (TR_VERBS_BEFORE.has(t[j]!)) spans.push([j, i]);
    // English: "send (this / it / the prompt) (over) to claude".
    if (t[i - 1] === 'to') {
      for (let j = Math.max(0, i - 6); j < i - 1; j++) if (EN_VERBS.has(t[j]!)) spans.push([j, i]);
    }
  }
  for (const [start, end] of spans) {
    const near = t.slice(Math.max(0, start - WINDOW), end + 1 + WINDOW);
    if (!near.some((w) => NEGATIONS.has(w))) return true;
  }
  return false;
}
