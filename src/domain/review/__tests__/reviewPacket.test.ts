import { describe, expect, it } from 'vitest';
import { newTask } from '../../task/task';
import { REVIEW_PACKET_MAX_CHARS, buildReviewPacketBody, type GitSnapshot } from '../reviewPacket';

const snap = (over: Partial<GitSnapshot>): GitSnapshot => ({
  phase: 'after',
  capturedAt: '',
  isRepo: true,
  branch: 'main',
  headSha: 'bbbbbbbbbb',
  statusShort: '',
  changedFiles: [],
  diffStat: null,
  diffExcerpt: null,
  truncated: false,
  error: null,
  ...over,
});

function task(prompt = 'Do X') {
  const t = newTask({ id: 't', workspaceId: 'w', prompt, sourceConversationUrl: null, sourceAssistantMessageId: null, claudeSessionIdBefore: null, now: '' });
  t.outcome = 'succeeded';
  t.claudeResult = 'Implemented X with tests.';
  return t;
}

describe('review packet', () => {
  it('contains outcome, result and git evidence and asks for a critical review', () => {
    const body = buildReviewPacketBody({
      projectName: 'Demo',
      task: task(),
      before: snap({ phase: 'before', headSha: 'aaaaaaaaaa' }),
      after: snap({ changedFiles: ['M src/a.ts'], diffStat: ' src/a.ts | 3 ++-', diffExcerpt: 'diff --git a/src/a.ts' }),
    });
    expect(body).toContain('Demo');
    expect(body).toContain('completed');
    expect(body).toContain('Implemented X with tests.');
    expect(body).toContain('- M src/a.ts');
    expect(body).toContain('aaaaaaaa → bbbbbbbb (new commits)');
    expect(body).toContain('review this implementation critically');
  });

  it('is bounded and handles non-repos', () => {
    const body = buildReviewPacketBody({ projectName: 'P', task: task('x'.repeat(50_000)), before: null, after: snap({ isRepo: false, error: 'not a Git repository' }) });
    expect(body.length).toBeLessThanOrEqual(REVIEW_PACKET_MAX_CHARS);
    expect(body).toContain('not a Git repository');
  });

  it('fences content safely even when it contains backticks', () => {
    const t = task();
    t.claudeResult = 'use ```js\ncode\n``` here';
    const body = buildReviewPacketBody({ projectName: 'P', task: t, before: null, after: null });
    expect(body).toContain('````\nuse ```js');
  });
});
