import { sanitizeTerminalPrompt } from './promptText';

/** Max length of the "Append to Claude prompts" text. */
export const MAX_PROMPT_SUFFIX_CHARS = 4000;

/** Initial value of the global "Append to Claude prompts" setting (the user may edit or clear it). */
export const DEFAULT_PROMPT_SUFFIX = [
  '1. Cevabında maddeler halinde yazacağın konular olursa hepsine numara ver ve sıralı/ardışık olsun; numaralar tekrar etmesin.',
  '2. Cevaplarında asla detaylı, gereksiz, uzun, anlamsız veya işlevsiz açıklamalar yazma. Her zaman kısa, net ve hızlı anlaşılır cevaplar ver.',
].join('\n');

/** The exact text sent to Claude: `prompt`, a blank line, then the suffix. An empty (or blank) suffix adds nothing. */
export function composeClaudePrompt(prompt: string, suffix: string | null | undefined): string {
  const tail = sanitizeTerminalPrompt(suffix ?? '').trim();
  return tail ? `${prompt}\n\n${tail}` : prompt;
}
