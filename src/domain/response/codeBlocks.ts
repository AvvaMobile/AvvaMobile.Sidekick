export interface CodeBlock {
  /** First word of the fence's info string (` ```python ` → `python`), null when unlabelled. */
  language: string | null;
  /** Exact code between the fences: no fences, no label, no structural newlines. */
  body: string;
}

/**
 * Fenced Markdown code blocks (backtick or tilde fences, CommonMark closing rules) of a raw assistant
 * message. The fence's own indentation (a block inside a list item) is stripped from each code line;
 * every other indentation is kept. A block that never closes runs to the end of the message.
 * Blocks whose body is blank are dropped. Never fed with terminal output, only raw response text.
 */
export function parseCodeBlocks(text: string): CodeBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: CodeBlock[] = [];
  let open: { char: string; len: number; indent: number; language: string | null; body: string[] } | null = null;

  const finish = () => {
    if (open && open.body.some((l) => l.trim())) blocks.push({ language: open.language, body: open.body.join('\n') });
    open = null;
  };

  for (const line of lines) {
    if (!open) {
      const m = /^([ \t]*)(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
      if (!m) continue;
      const fence = m[2]!;
      const info = m[3]!.trim();
      if (fence[0] === '`' && info.includes('`')) continue; // inline code, not a fence
      open = { char: fence[0]!, len: fence.length, indent: m[1]!.length, language: info.split(/\s+/)[0] || null, body: [] };
      continue;
    }
    const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close && close[1]![0] === open.char && close[1]!.length >= open.len) {
      finish();
      continue;
    }
    let strip = 0;
    while (strip < open.indent && (line[strip] === ' ' || line[strip] === '\t')) strip++;
    open.body.push(line.slice(strip));
  }
  finish();
  return blocks;
}
