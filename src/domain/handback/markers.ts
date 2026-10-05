/** Per-task final-output markers: only the text between this task's own START and END marker is handed back. */
export interface TaskMarker {
  taskId: string;
  nonce: string;
}

export const markerStart = (m: TaskMarker) => `<<<SIDEKICK_START:${m.taskId}:${m.nonce}>>>`;
export const markerEnd = (m: TaskMarker) => `<<<SIDEKICK_END:${m.taskId}:${m.nonce}>>>`;

/** Appended to the prompt that is sent to Claude (never stored in the task's prompt, never sent back to ChatGPT). */
export function markerInstruction(m: TaskMarker): string {
  return [
    '',
    '',
    'FINAL OUTPUT FORMAT (required): when you are completely done, end your final reply with your final answer wrapped exactly like this, with these two marker lines copied character for character:',
    markerStart(m),
    'FINAL ANSWER',
    markerEnd(m),
  ].join('\n');
}

/**
 * Content between this task's START and END marker (both required, taskId and nonce must match exactly), or null.
 * The last complete pair wins; text outside the markers and markers of any other task/nonce are ignored.
 */
export function extractMarked(text: string | null | undefined, m: TaskMarker): string | null {
  if (!text) return null;
  const start = markerStart(m);
  const end = markerEnd(m);
  let found: string | null = null;
  let from = 0;
  for (;;) {
    const s = text.indexOf(start, from);
    if (s < 0) break;
    const bodyStart = s + start.length;
    const e = text.indexOf(end, bodyStart);
    if (e < 0) break;
    const body = text.slice(bodyStart, e).trim();
    // A pair whose body is the instruction's own placeholder (Claude echoed the template) is not an answer.
    if (body && body !== 'FINAL ANSWER') found = body;
    from = e + end.length;
  }
  return found;
}
