import { describe, expect, it } from 'vitest';
import { extractMarked, markerEnd, markerInstruction, markerStart } from '../markers';

const m = { taskId: 't1', nonce: 'abc123' };

describe('task markers', () => {
  it('instruction carries this task\'s exact START and END markers', () => {
    const i = markerInstruction(m);
    expect(i).toContain('<<<SIDEKICK_START:t1:abc123>>>');
    expect(i).toContain('<<<SIDEKICK_END:t1:abc123>>>');
  });
  it('returns only the text between the markers', () => {
    expect(extractMarked(`chatter\n${markerStart(m)}\nthe answer\n${markerEnd(m)}\nbye`, m)).toBe('the answer');
  });
  it('rejects a wrong nonce or wrong task id', () => {
    const fake = { taskId: 't1', nonce: 'zzz' };
    expect(extractMarked(`${markerStart(fake)}x${markerEnd(fake)}`, m)).toBeNull();
    const other = { taskId: 't2', nonce: 'abc123' };
    expect(extractMarked(`${markerStart(other)}x${markerEnd(other)}`, m)).toBeNull();
  });
  it('rejects a missing END or missing START', () => {
    expect(extractMarked(`${markerStart(m)}\nanswer`, m)).toBeNull();
    expect(extractMarked(`answer\n${markerEnd(m)}`, m)).toBeNull();
    expect(extractMarked('plain answer', m)).toBeNull();
    expect(extractMarked(null, m)).toBeNull();
  });
  it('ignores an echoed template and takes the last real pair', () => {
    const t = `${markerStart(m)}\nFINAL ANSWER\n${markerEnd(m)}\n${markerStart(m)}\nreal\n${markerEnd(m)}`;
    expect(extractMarked(t, m)).toBe('real');
    expect(extractMarked(`${markerStart(m)}\nFINAL ANSWER\n${markerEnd(m)}`, m)).toBeNull();
  });
});
