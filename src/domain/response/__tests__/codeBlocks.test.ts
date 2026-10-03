import { describe, expect, it } from 'vitest';
import { parseCodeBlocks } from '../codeBlocks';

// The raw transcript text of a real Claude answer (verified from the session transcript).
const RAW = 'Aga, bu Python kodu ekrana "hello" yazdırır.\n\n```python\nprint("hello")\n```';

describe('parseCodeBlocks', () => {
  it('prose + one python block → body only, no fences, no label', () => {
    expect(parseCodeBlocks(RAW)).toEqual([{ language: 'python', body: 'print("hello")' }]);
  });

  it('one bash block', () => {
    expect(parseCodeBlocks('```bash\nnpm install\nnpm run app\n```')).toEqual([{ language: 'bash', body: 'npm install\nnpm run app' }]);
  });

  it('several blocks keep their order and languages; unlabelled → null', () => {
    const r = parseCodeBlocks('a\n```bash\nls\n```\nb\n```json\n{"a": 1}\n```\n```\nplain\n```');
    expect(r.map((b) => [b.language, b.body])).toEqual([
      ['bash', 'ls'],
      ['json', '{"a": 1}'],
      [null, 'plain'],
    ]);
  });

  it('no fenced block → empty list', () => {
    expect(parseCodeBlocks('Just prose with `inline` code and ``` in a sentence.')).toEqual([]);
  });

  it('keeps indentation, blank lines and quotes inside the code exactly', () => {
    const code = 'def f():\n    if x:\n\n        return \'a "b"\'\n\treturn 1';
    expect(parseCodeBlocks('```python\n' + code + '\n```')[0]!.body).toBe(code);
  });

  it('keeps a trailing blank line that belongs to the code', () => {
    expect(parseCodeBlocks('```\na\n\n```')[0]!.body).toBe('a\n');
  });

  it('a longer fence can contain shorter fences (markdown inside markdown)', () => {
    const r = parseCodeBlocks('````markdown\n```bash\nls\n```\n````');
    expect(r).toEqual([{ language: 'markdown', body: '```bash\nls\n```' }]);
  });

  it('tilde fences and info strings with extra words', () => {
    expect(parseCodeBlocks('~~~ts title="x.ts"\nconst a = 1;\n~~~')).toEqual([{ language: 'ts', body: 'const a = 1;' }]);
  });

  it('a fence indented inside a list item loses only the fence indentation', () => {
    const r = parseCodeBlocks('1. Run:\n   ```bash\n   cd app\n     npm i\n   ```\n2. Done');
    expect(r).toEqual([{ language: 'bash', body: 'cd app\n  npm i' }]);
  });

  it('an unclosed fence runs to the end of the message', () => {
    expect(parseCodeBlocks('x\n```bash\nls\npwd')).toEqual([{ language: 'bash', body: 'ls\npwd' }]);
  });

  it('CRLF is normalised', () => {
    expect(parseCodeBlocks('```bash\r\nls\r\npwd\r\n```\r\n')).toEqual([{ language: 'bash', body: 'ls\npwd' }]);
  });

  it('terminal renderer decorations are irrelevant: only the raw message is parsed, and a "! " line stays code', () => {
    expect(parseCodeBlocks('Açıklama.\n\n```text\n! print("hello")\n```')).toEqual([{ language: 'text', body: '! print("hello")' }]);
    expect(parseCodeBlocks('● Açıklama.\n  ! print("hello")')).toEqual([]);
  });

  it('blank-bodied blocks are ignored', () => {
    expect(parseCodeBlocks('```\n\n```')).toEqual([]);
  });
});
