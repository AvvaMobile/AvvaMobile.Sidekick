import { sourcePrompt, type TaskRecord } from '../task/task';

export interface GitSnapshot {
  phase: 'before' | 'after';
  capturedAt: string;
  isRepo: boolean;
  branch: string | null;
  headSha: string | null;
  statusShort: string;
  changedFiles: string[];
  diffStat: string | null;
  diffExcerpt: string | null;
  truncated: boolean;
  error: string | null;
}

export interface ReviewPacket {
  id: string;
  taskId: string;
  workspaceId: string;
  createdAt: string;
  body: string;
  deliveryStatus: 'pending' | 'sent' | 'failed';
  deliveryAttempts: number;
  lastDeliveryError: string | null;
}

export const REVIEW_PACKET_MAX_CHARS = 24_000;
const PROMPT_EXCERPT = 1_500;
const RESULT_MAX = 8_000;
const FILES_MAX = 80;

const OUTCOME_LABEL: Record<string, string> = {
  succeeded: 'completed',
  failed: 'FAILED',
  cancelled: 'cancelled by the user',
  interrupted: 'interrupted (application closed while running)',
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function fence(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

/**
 * Builds the bounded review packet sent (only after user approval) to the Workspace's ChatGPT
 * conversation. Contains the task outcome, Claude's final result and Git evidence; never the full
 * Claude stream, never credentials (diff excerpts already exclude secret-looking files).
 */
export function buildReviewPacketBody(args: {
  projectName: string;
  task: TaskRecord;
  before: GitSnapshot | null;
  after: GitSnapshot | null;
}): string {
  const { task, before, after, projectName } = args;
  const outcome = OUTCOME_LABEL[task.outcome ?? 'failed'] ?? String(task.outcome);
  const lines: string[] = [];
  lines.push(`Sidekick review packet — ${projectName}`);
  lines.push('');
  lines.push(`Claude Code task ${outcome}.`);
  if (task.error) lines.push(`Error: ${task.error.message}`);
  lines.push('');
  lines.push('Prompt that was sent to Claude (excerpt):');
  lines.push(fence(clip(sourcePrompt(task), PROMPT_EXCERPT)));
  lines.push('');
  lines.push("Claude's final result:");
  lines.push(fence(clip(task.claudeResult?.trim() || '(no final result reported)', RESULT_MAX)));
  lines.push('');

  if (!after || !after.isRepo) {
    lines.push(`Git evidence: ${after?.error ?? 'project is not a Git repository'}.`);
  } else {
    const moved = before?.headSha && after.headSha && before.headSha !== after.headSha;
    lines.push(`Git: branch ${after.branch ?? '(detached)'}, HEAD ${short(before?.headSha)} → ${short(after.headSha)}${moved ? ' (new commits)' : ''}`);
    if (before?.statusShort.trim()) lines.push('Note: the working tree already had uncommitted changes before the task; they are included below.');
    lines.push('');
    const files = after.changedFiles;
    lines.push(`Changed files (${files.length}):`);
    lines.push(files.length ? files.slice(0, FILES_MAX).map((f) => `- ${f}`).join('\n') + (files.length > FILES_MAX ? `\n- … ${files.length - FILES_MAX} more` : '') : '- none');
    if (after.diffStat?.trim()) {
      lines.push('');
      lines.push('Diff stat:');
      lines.push(fence(after.diffStat.trim()));
    }
    if (after.diffExcerpt?.trim()) {
      lines.push('');
      lines.push(`Diff excerpt${after.truncated ? ' (truncated)' : ''}:`);
      lines.push(fence(after.diffExcerpt.trim()));
    }
  }
  lines.push('');
  lines.push('Please review this implementation critically against the prompt: correctness, missing requirements, risks and tests. Then tell me what to do next.');

  const body = lines.join('\n');
  return body.length <= REVIEW_PACKET_MAX_CHARS ? body : `${body.slice(0, REVIEW_PACKET_MAX_CHARS - 40)}\n… [review packet truncated]`;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '(none)';
}
