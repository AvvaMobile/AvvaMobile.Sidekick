import { describe, expect, it } from 'vitest';
import type { FlowEntry } from '../../../shared/state';
import { appendFlow, FLOW_LOG_LIMIT } from '../flow';

const T = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();

describe('flow log', () => {
  it('numbers entries and keeps only the newest', () => {
    let l: FlowEntry[] = [];
    for (let i = 0; i < FLOW_LOG_LIMIT + 5; i++) l = appendFlow(l, { at: T(0), kind: 'chatgpt_started', detail: String(i) });
    expect(l).toHaveLength(FLOW_LOG_LIMIT);
    expect(l.at(-1)!.seq).toBe(FLOW_LOG_LIMIT + 5);
    expect(l[0]!.detail).toBe('5');
  });
});
