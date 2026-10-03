/**
 * Makes a Claude Prompt safe to paste into the terminal as one bracketed paste (SECURITY: the prompt is
 * ChatGPT output). Line endings become `\n`; escape sequences (CSI, OSC, DCS/APC/PM/SOS strings and
 * two-character escapes) are removed entirely, so the paste-end marker `ESC[201~` can never appear;
 * every other C0/C1 control character except `\n` and `\t` (and DEL) is dropped.
 */
export function sanitizeTerminalPrompt(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // OSC / DCS / SOS / PM / APC strings up to BEL or ST (or the end of the text).
      .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
      // CSI sequences.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
      // SS2 / SS3 (one following character).
      .replace(/\x1b[NO][\s\S]?/g, '')
      // Any other escape: ESC plus its intermediate and final bytes.
      .replace(/\x1b[ -/]*[0-~]?/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  );
}
