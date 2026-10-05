import type { TaskOutcome, TaskStatus } from '../../shared/state';

export interface TaskError {
  code: string;
  message: string;
  detail?: string;
  retryable: boolean;
}

export interface TaskRecord {
  readonly id: string;
  readonly workspaceId: string;
  /** Frozen at creation (queued); never modified afterwards. */
  readonly prompt: string;
  /** Older versions only: the ChatGPT prompt before the "Append to Claude prompts" text was added; never set now. */
  readonly originalPrompt?: string;
  readonly sourceConversationUrl: string | null;
  readonly sourceAssistantMessageId: string | null;
  readonly createdAt: string;
  readonly claudeSessionIdBefore: string | null;
  status: TaskStatus;
  outcome: TaskOutcome | null;
  startedAt: string | null;
  completedAt: string | null;
  claudeSessionIdAfter: string | null;
  processExitCode: number | null;
  processSignal: string | null;
  claudeResult: string | null;
  reviewPacketId: string | null;
  error: TaskError | null;
}

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'interrupted'],
  succeeded: ['review_pending'],
  failed: ['review_pending'],
  cancelled: ['review_pending'],
  interrupted: ['review_pending'],
  review_pending: ['review_sent'],
  review_sent: [],
};

function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(task: TaskRecord, to: TaskStatus): void {
  if (!canTransition(task.status, to)) throw new Error(`illegal task transition ${task.status} -> ${to}`);
  task.status = to;
}

/** The prompt as ChatGPT wrote it, without the text older versions appended ("Append to Claude prompts"). */
export function sourcePrompt(task: Pick<TaskRecord, 'prompt' | 'originalPrompt'>): string {
  return task.originalPrompt ?? task.prompt;
}

/** A task that still owns (or is about to own) the Workspace's Claude process. */
export function isTaskActive(task: TaskRecord | null | undefined): boolean {
  return !!task && (task.status === 'queued' || task.status === 'running');
}

export function newTask(args: {
  id: string;
  workspaceId: string;
  prompt: string;
  originalPrompt?: string;
  sourceConversationUrl: string | null;
  sourceAssistantMessageId: string | null;
  claudeSessionIdBefore: string | null;
  now: string;
}): TaskRecord {
  return {
    id: args.id,
    workspaceId: args.workspaceId,
    prompt: args.prompt,
    ...(args.originalPrompt !== undefined && args.originalPrompt !== args.prompt ? { originalPrompt: args.originalPrompt } : {}),
    sourceConversationUrl: args.sourceConversationUrl,
    sourceAssistantMessageId: args.sourceAssistantMessageId,
    createdAt: args.now,
    claudeSessionIdBefore: args.claudeSessionIdBefore,
    status: 'queued',
    outcome: null,
    startedAt: null,
    completedAt: null,
    claudeSessionIdAfter: null,
    processExitCode: null,
    processSignal: null,
    claudeResult: null,
    reviewPacketId: null,
    error: null,
  };
}
