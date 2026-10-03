import { describe, expect, it, vi } from 'vitest';
import { ResponseCopier } from '../ResponseCopier';
import type { StopEvent } from '../../claude/StopHookChannel';

const stop = (text: string | null, transcriptPath: string | null = null): StopEvent => ({ sessionId: 's', transcriptPath, lastAssistantMessage: text });
const make = (transcripts: Record<string, string> = {}) => {
  const clipboard = { writeText: vi.fn() };
  return { clipboard, c: new ResponseCopier(clipboard, (p) => transcripts[p] ?? null) };
};
const PY = 'Aga, bu kod "hello" yazdırır.\n\n```python\nprint("hello")\n```';

describe('ResponseCopier', () => {
  it('prose + one block → clipboard is exactly the code body', () => {
    const { c, clipboard } = make();
    c.record('w', stop(PY));
    expect(c.copy('w', 'auto')).toEqual({ ok: true, kind: 'code' });
    expect(clipboard.writeText).toHaveBeenCalledOnce();
    expect(clipboard.writeText).toHaveBeenCalledWith('print("hello")');
  });

  it('single block: "full" is the secondary option and copies the whole response', () => {
    const { c, clipboard } = make();
    c.record('w', stop(PY));
    expect(c.copy('w', 'full')).toEqual({ ok: true, kind: 'response' });
    expect(clipboard.writeText).toHaveBeenCalledWith(PY);
  });

  it('multiple blocks → needs a choice, nothing is copied', () => {
    const { c, clipboard } = make();
    c.record('w', stop('```bash\nnpm i\n```\n```json\n{"a":1}\n```'));
    expect(c.copy('w', 'auto')).toEqual({
      ok: false,
      code: 'choose',
      blocks: [
        { language: 'bash', preview: 'npm i' },
        { language: 'json', preview: '{"a":1}' },
      ],
    });
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(c.copy('w', { block: 1 })).toEqual({ ok: true, kind: 'code' });
    expect(clipboard.writeText).toHaveBeenLastCalledWith('{"a":1}');
  });

  it('no code blocks → full response', () => {
    const { c, clipboard } = make();
    c.record('w', stop('Only prose.'));
    expect(c.copy('w', 'auto')).toEqual({ ok: true, kind: 'response' });
    expect(clipboard.writeText).toHaveBeenCalledWith('Only prose.');
  });

  it('nothing recorded → empty, clipboard untouched; a bad block index is rejected', () => {
    const { c, clipboard } = make();
    expect(c.copy('w', 'auto')).toMatchObject({ ok: false, code: 'empty' });
    c.record('w', stop(PY));
    expect(c.copy('w', { block: 5 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(c.copy('w', { block: 0.5 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it('falls back to the transcript when the hook has no last_assistant_message', () => {
    const t = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: PY }] } }),
    ].join('\n');
    const { c, clipboard } = make({ '/t.jsonl': t });
    c.record('w', stop(null, '/t.jsonl'));
    c.copy('w', 'auto');
    expect(clipboard.writeText).toHaveBeenCalledWith('print("hello")');
  });

  it('a later Stop replaces the response; an empty Stop keeps the previous one; Workspaces are independent', () => {
    const { c, clipboard } = make();
    c.record('a', stop('one'));
    c.record('b', stop('other'));
    c.record('a', stop(null));
    c.copy('a', 'auto');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('one');
    c.record('a', stop('two'));
    c.copy('a', 'auto');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('two');
    c.forget('a');
    expect(c.info('a').available).toBe(false);
    expect(c.info('b').available).toBe(true);
  });

  it('keeps working while the Claude turn is still running (no dependency on task state)', () => {
    const { c } = make();
    c.record('w', stop(PY));
    // A new prompt was submitted but no Stop yet: the previous completed response is still copyable.
    expect(c.copy('w', 'auto')).toEqual({ ok: true, kind: 'code' });
  });
});
