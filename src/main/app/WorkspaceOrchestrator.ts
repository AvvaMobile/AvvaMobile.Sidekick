import { randomUUID } from 'node:crypto';
import { buildReviewPacketBody, type GitSnapshot, type ReviewPacket } from '../../domain/review/reviewPacket';
import { appendFlow } from '../../domain/flow/flow';
import { AUTO_SEND_DELAY_MS, isSendToClaudeRequest } from '../../domain/handoff/autoSend';
import { composeClaudePrompt } from '../../domain/handoff/promptSuffix';
import { isTaskActive, newTask, sourcePrompt, transition, type TaskRecord } from '../../domain/task/task';
import { initialFor } from '../../domain/workspace/workspace';
import type { AttentionState, FlowKind, LatestReviewView, TaskView, WorkspaceView } from '../../shared/state';
import type { AdapterResult, ClaudePromptCandidate } from '../chatgpt/ChatGPTAdapter';
import type { ClaudeRunHandle, ClaudeRunnerPort, ClaudeStreamEvent } from '../claude/ClaudeRunner';
import { CLAUDE_BUSY_MESSAGE } from '../claude/InteractiveClaudeRunner';
import type { DevelopmentPaneRegistry } from '../development/DevelopmentPane';
import type { GitEvidencePort } from '../git/GitEvidence';
import { HandoffController, type FrozenTask, type HandoffTrigger, type PromptCandidateSource } from '../orchestration/HandoffController';
import type { ModelChoice } from '../../shared/models';
import type { AppStateStore } from './AppStateStore';

/** What the orchestrator needs from a Workspace's ChatGPT adapter. */
export interface ChatPort extends PromptCandidateSource {
  insertComposerText(text: string, opts?: { allowNonEmpty?: boolean }): Promise<AdapterResult<{ inserted: number }>>;
  submitComposer(): Promise<AdapterResult<{ via: string }>>;
  /** Makes sure the view shows the conversation a result belongs to (restoring it if the user moved on); never guesses. */
  ensureConversation(url: string | null): Promise<AdapterResult<{ restored: boolean }>>;
  /** The user's latest ChatGPT message (read only to detect an explicit "send it to Claude", D034). */
  getLatestUserMessage(): Promise<AdapterResult<{ text: string; messageId: string | null }>>;
}

export interface TaskFinishedNotice {
  workspaceId: string;
  workspaceName: string;
  taskId: string;
  kind: 'success' | 'error' | 'info';
  title: string;
  body: string;
  /** The Workspace was not the visible, focused one when the task finished. */
  background: boolean;
}

/** The flow is waiting for the user while the window is in the background. */
export type FlowNotice = Omit<TaskFinishedNotice, 'taskId' | 'background'>;

export interface OrchestratorDeps {
  store: AppStateStore;
  panes: DevelopmentPaneRegistry;
  runner: ClaudeRunnerPort;
  git: GitEvidencePort;
  chatFor(workspaceId: string): ChatPort | null;
  isForeground(workspaceId: string): boolean;
  notifyTaskFinished(notice: TaskFinishedNotice): void;
  /** Background-only nudge: one side finished and the other has not been told. */
  notifyFlow?(notice: FlowNotice): void;
  onChange(): void;
  /** Custom icon data URL for a Workspace (presentation only). */
  iconFor?(workspaceId: string): string | null;
  /** Model Claude Code uses when the Workspace has no explicit choice. */
  defaultModel?(): ModelChoice | null;
  /** The terminal's Claude is in the middle of a turn (a prompt submitted, no Stop yet). */
  claudeBusy?(workspaceId: string): boolean;
  /** A managed task reached its final state (nothing is running for this Workspace any more). */
  taskSettled?(workspaceId: string): void;
  /** Automatic handback: how long (ms) and how often to wait for ChatGPT to be free (replying / draft in the box). */
  handbackWait?: { intervalMs: number; maxWaits: number };
  newId?: () => string;
  now?: () => Date;
}

interface Runtime {
  generating: boolean;
  loggedIn: boolean | null;
  attention: AttentionState;
  run: ClaudeRunHandle | null;
  cancelRequested: boolean;
  resultSeen: boolean;
  reviewSending: boolean;
  /** Task whose review packet the user can hand to ChatGPT: the latest completed result, independent of a task that is running now. */
  reviewTaskId: string | null;
  /** Send to Claude capture in progress (blocks double clicks). */
  sending: boolean;
  terminal: { running: boolean; error: string | null };
  /** A newly seen block becomes the candidate only when the next observation sees it unchanged. */
  pendingCandidateKey: string | null;
  /** Candidate key whose user message is being checked for a send-to-Claude request. */
  autoSendCheck: string | null;
  /** Latest ChatGPT user message seen by the poll: undefined until the first read (that one is only a baseline), '' when the chat has none. */
  userMessageKey: string | undefined;
  /** `request + candidate` pairs that already got a countdown: one request never starts two for the same prompt. */
  scheduledPairs: Set<string>;
  /** Consecutive observations without a usable prompt block (a single odd read must not drop the candidate). */
  candidateMisses: number;
  /** Short feedback for the user when an auto-send request could not start or run. */
  notice: { text: string; at: string } | null;
  /** An intercepted command that arrived while ChatGPT was still writing the prompt: it fires with that prompt (D045). */
  pendingIntent: { requestId: string; at: number } | null;
  /** Scheduled user-requested auto-send (D034). `waits`: seconds spent waiting for ChatGPT to finish its reply. */
  autoSend: { key: string; messageId: string | null; at: string; timer: ReturnType<typeof setTimeout>; waits: number } | null;
}

/** Observations without a prompt block before the candidate is dropped. */
const CANDIDATE_MISS_LIMIT = 3;
/** How long an intercepted command waits for ChatGPT to finish writing its prompt. */
const PENDING_INTENT_MS = 60_000;
/** Most 1 s waits for ChatGPT to finish replying before an armed auto-send gives up waiting. */
const AUTO_SEND_MAX_WAITS = 90;

export type OpResult = { ok: true } | { ok: false; code: string; detail: string };

/**
 * Per-Workspace orchestration: candidate prompt -> explicit send intent -> managed run ->
 * evidence -> review packet -> automatic handback to the originating conversation (WORKFLOW §1, D005, D024, D040).
 *
 * Every piece of state is keyed by workspaceId. Nothing here is driven by terminal/PTY activity,
 * and nothing here runs because ChatGPT produced output (the only automatic send is the user's own
 * explicit request in ChatGPT, after a cancellable countdown — D034).
 */
export class WorkspaceOrchestrator {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly handoff: HandoffController;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.handoff = new HandoffController(this.newId, this.now);
  }

  register(workspaceId: string): void {
    if (this.runtimes.has(workspaceId)) return;
    this.deps.panes.ensure(workspaceId);
    this.failInterruptedDelivery(workspaceId);
    this.runtimes.set(workspaceId, {
      generating: false,
      loggedIn: null,
      attention: 'none',
      run: null,
      cancelRequested: false,
      resultSeen: false,
      reviewSending: false,
      reviewTaskId: null,
      sending: false,
      terminal: { running: false, error: null },
      pendingCandidateKey: null,
      autoSendCheck: null,
      userMessageKey: undefined,
      scheduledPairs: new Set(),
      candidateMisses: 0,
      notice: null,
      pendingIntent: null,
      autoSend: null,
    });
  }

  /** A result whose automatic delivery was cut short by quitting the app: keep it and offer Retry. */
  private failInterruptedDelivery(workspaceId: string): void {
    const task = this.currentTask(workspaceId);
    const packet = task?.status === 'review_pending' && task.outcome === 'succeeded' ? this.deps.store.reviewPacket(task.reviewPacketId) : undefined;
    if (!packet || packet.deliveryStatus !== 'pending') return;
    packet.deliveryStatus = 'failed';
    packet.lastDeliveryError = 'Delivery to ChatGPT was interrupted.';
    this.deps.store.putReviewPacket(packet);
  }

  unregister(workspaceId: string): void {
    const rt = this.runtimes.get(workspaceId);
    if (rt) this.cancelAutoSend(workspaceId, rt);
    rt?.run?.cancel();
    this.runtimes.delete(workspaceId);
    this.handoff.forget(workspaceId);
    this.deps.panes.dispose(workspaceId);
  }

  /** Application shutdown: stop every managed Claude process (tasks are marked interrupted on next start). */
  shutdown(): void {
    for (const [id, rt] of this.runtimes) {
      this.cancelAutoSend(id, rt);
      rt.cancelRequested = true;
      rt.run?.cancel();
    }
  }

  // ---------- ChatGPT observation (passive) ----------

  /** DOM observation result for one Workspace. Updates the candidate preview only; never launches anything. */
  observeCandidate(workspaceId: string, res: AdapterResult<ClaudePromptCandidate>): void {
    const rt = this.runtimes.get(workspaceId);
    if (!rt) return;
    const before = JSON.stringify([this.handoff.getCandidate(workspaceId)?.text, this.handoff.getCandidate(workspaceId)?.messageId, rt.generating, rt.loggedIn]);
    const wasGenerating = rt.generating;
    if (res.ok) {
      rt.generating = false;
      rt.loggedIn = true;
      rt.candidateMisses = 0;
      const cur = this.handoff.getCandidate(workspaceId);
      const key = candidateKey(res.value.messageId, res.value.text);
      if (res.value.truncated) {
        rt.pendingCandidateKey = null;
        this.handoff.observeCandidate(workspaceId, null);
      } else if (cur && cur.text === res.value.text && cur.messageId === res.value.messageId) {
        rt.pendingCandidateKey = null;
      } else if (rt.pendingCandidateKey === key) {
        // Seen unchanged on two consecutive observations: ChatGPT has finished writing it.
        rt.pendingCandidateKey = null;
        this.handoff.observeCandidate(workspaceId, res.value);
        this.promptReady(workspaceId, res.value.text, res.value.messageId);
      } else {
        rt.pendingCandidateKey = key;
      }
    } else if (res.code === 'still_generating') {
      rt.generating = true;
    } else if (res.code === 'no_prompt_block' || res.code === 'no_assistant_messages' || res.code === 'wrong_origin' || res.code === 'view_unavailable') {
      rt.generating = false;
      // A prompt stays the candidate until it is really gone, not after one odd read.
      if (++rt.candidateMisses >= CANDIDATE_MISS_LIMIT) {
        rt.pendingCandidateKey = null;
        this.handoff.observeCandidate(workspaceId, null);
      }
    }
    // timeout/script_error: keep the previous state (transient).
    // A pending auto-send only survives while exactly that prompt stays ready and ChatGPT is quiet.
    const cand = this.handoff.getCandidate(workspaceId);
    const candKey = cand ? candidateKey(cand.messageId, cand.text) : null;
    if (rt.autoSendCheck && rt.autoSendCheck !== candKey) rt.autoSendCheck = null;
    // ChatGPT replying to the request ("I cannot send it directly…") does not cancel it; the prompt changing does.
    if (rt.autoSend && rt.autoSend.key !== candKey) {
      this.cancelAutoSend(workspaceId, rt);
      if (!candKey) this.setNotice(workspaceId, rt, NOTICE_NO_PROMPT);
    }
    if (!wasGenerating && rt.generating) this.flow(workspaceId, 'chatgpt_started', 'ChatGPT started writing');
    // A reply only counts as finished when ChatGPT was actually read again (not when the view vanished).
    else if (wasGenerating && !rt.generating && (res.ok || res.code === 'no_prompt_block' || res.code === 'no_assistant_messages')) {
      this.flow(workspaceId, 'chatgpt_replied', 'ChatGPT finished its reply');
    }
    const after = JSON.stringify([this.handoff.getCandidate(workspaceId)?.text, this.handoff.getCandidate(workspaceId)?.messageId, rt.generating, rt.loggedIn]);
    if (before !== after) this.deps.onChange();
  }

  setChatLoggedIn(workspaceId: string, loggedIn: boolean | null): void {
    const rt = this.runtimes.get(workspaceId);
    if (!rt || rt.loggedIn === loggedIn) return;
    rt.loggedIn = loggedIn;
    this.deps.onChange();
  }

  setTerminalState(workspaceId: string, state: { running: boolean; error: string | null }): void {
    const rt = this.runtimes.get(workspaceId);
    if (!rt) return;
    rt.terminal = state;
    this.deps.onChange();
  }

  // ---------- Send to Claude (explicit) ----------

  /**
   * Explicit Send to Claude (single click, D024): capture the latest Claude Prompt block of this
   * Workspace, freeze it into a Task and start Claude. Re-entrant clicks are ignored.
   */
  async sendToClaude(workspaceId: string, trigger: HandoffTrigger, expectMessageId?: string | null): Promise<OpResult & { taskId?: string }> {
    const ws = this.deps.store.workspace(workspaceId);
    const rt = this.runtimes.get(workspaceId);
    if (!ws || !rt) return { ok: false, code: 'unknown_workspace', detail: 'Workspace not found' };
    // Any explicit send supersedes a pending auto-send.
    if (trigger !== 'auto_user_request') {
      rt.autoSendCheck = null;
      this.cancelAutoSend(workspaceId, rt);
    }
    if (rt.sending || rt.run || isTaskActive(this.currentTask(workspaceId)))
      return { ok: false, code: 'task_active', detail: 'A Claude task is already running in this Workspace' };
    // Never queue behind a turn already running in the terminal: its Stop would be mistaken for ours.
    if (this.deps.claudeBusy?.(workspaceId)) return { ok: false, code: 'claude_busy', detail: CLAUDE_BUSY_MESSAGE };
    const chat = this.deps.chatFor(workspaceId);
    if (!chat) return { ok: false, code: 'view_unavailable', detail: 'ChatGPT is not ready in this Workspace' };
    rt.sending = true;
    this.deps.onChange();
    let frozen: FrozenTask;
    let finalPrompt: string;
    try {
      const res = await this.handoff.send(workspaceId, chat, trigger);
      if (!res.ok) return res;
      // Auto-send only ever sends the very ChatGPT message the user's request was about.
      if (expectMessageId !== undefined && res.task.sourceMessageId !== expectMessageId)
        return { ok: false, code: 'candidate_changed', detail: 'The Claude Prompt changed before it was sent' };
      const last = this.currentTask(workspaceId);
      // Without a preview step, one click must not silently re-run work that already succeeded.
      if (last && sourcePrompt(last) === res.task.prompt && last.outcome === 'succeeded')
        return { ok: false, code: 'already_sent', detail: 'This Claude Prompt was already run successfully. Ask ChatGPT for a new prompt.' };
      frozen = res.task;
      // Frozen here: later Settings changes never touch this task.
      finalPrompt = composeClaudePrompt(frozen.prompt, this.deps.store.preferences().claudePromptSuffix);
    } finally {
      rt.sending = false;
    }
    if (!this.runtimes.has(workspaceId) || !this.deps.store.workspace(workspaceId)) return { ok: false, code: 'unknown_workspace', detail: 'Workspace removed' };
    const task = newTask({
      id: frozen.taskId,
      workspaceId,
      prompt: finalPrompt,
      originalPrompt: frozen.prompt,
      sourceConversationUrl: frozen.conversationUrl,
      sourceAssistantMessageId: frozen.sourceMessageId,
      claudeSessionIdBefore: ws.claudeSessionId,
      now: frozen.createdAt,
    });
    this.deps.store.putTask(task);
    this.deps.store.updateWorkspace(workspaceId, { lastTaskId: task.id });
    rt.cancelRequested = false;
    rt.resultSeen = false;
    rt.attention = 'none';
    // Placeholder handle so nothing else can start before the process exists.
    rt.run = { cancel: () => (rt.cancelRequested = true) };
    this.flow(workspaceId, 'sent_to_claude', firstLine(task.prompt), frozen.sourceMessageId);
    this.deps.onChange();
    void this.run(workspaceId, task).catch((err: unknown) => this.crashed(workspaceId, task, err));
    return { ok: true, taskId: task.id };
  }

  cancelTask(workspaceId: string): OpResult {
    const rt = this.runtimes.get(workspaceId);
    const task = this.currentTask(workspaceId);
    if (!rt || !rt.run || !isTaskActive(task)) return { ok: false, code: 'no_active_task', detail: 'No running task' };
    rt.cancelRequested = true;
    rt.run.cancel();
    this.deps.onChange();
    return { ok: true };
  }

  resetSession(workspaceId: string): OpResult {
    const ws = this.deps.store.workspace(workspaceId);
    if (!ws) return { ok: false, code: 'unknown_workspace', detail: 'Workspace not found' };
    if (isTaskActive(this.currentTask(workspaceId))) return { ok: false, code: 'task_active', detail: 'Stop the running task first' };
    this.deps.store.updateWorkspace(workspaceId, { claudeSessionId: null });
    this.deps.onChange();
    return { ok: true };
  }

  private async run(workspaceId: string, task: TaskRecord): Promise<void> {
    const ws = this.deps.store.workspace(workspaceId)!;
    const rt = this.runtimes.get(workspaceId)!;
    const before = await this.deps.git.snapshot(ws.projectPath, 'before').catch(() => null);
    if (!this.runtimes.has(workspaceId)) return;
    if (rt.cancelRequested) {
      transition(task, 'cancelled');
      task.outcome = 'cancelled';
      task.completedAt = this.now().toISOString();
      rt.run = null;
      await this.finish(workspaceId, task, before);
      return;
    }
    transition(task, 'running');
    task.startedAt = this.now().toISOString();
    this.deps.store.putTask(task);
    this.deps.onChange();

    rt.run = this.deps.runner.start({
      taskId: task.id,
      workspaceId,
      cwd: ws.projectPath,
      prompt: task.prompt,
      resumeSessionId: task.claudeSessionIdBefore,
      onEvent: (ev) => this.onClaudeEvent(workspaceId, task, ev),
      onExit: (exit) => {
        const live = this.runtimes.get(workspaceId);
        if (!live) return;
        live.run = null;
        task.processExitCode = exit.code;
        task.processSignal = exit.signal;
        task.completedAt = this.now().toISOString();
        if (live.cancelRequested || exit.cancelled) {
          transition(task, 'cancelled');
          task.outcome = 'cancelled';
        } else if (live.resultSeen && !task.error) {
          transition(task, 'succeeded');
          task.outcome = 'succeeded';
        } else {
          transition(task, 'failed');
          task.outcome = 'failed';
          task.error ??= exit.spawnError
            ? { code: 'spawn_failed', message: exit.spawnError, retryable: true }
            : { code: 'no_result', message: `Claude exited (code ${exit.code ?? 'none'}${exit.signal ? `, ${exit.signal}` : ''}) without a final result`, retryable: true };
        }
        void this.finish(workspaceId, task, before).catch((err: unknown) => this.crashed(workspaceId, task, err));
      },
    });
    if (rt.cancelRequested) rt.run.cancel();
  }

  /** An unexpected error while starting or finishing a task: never leave it queued/running forever. */
  private crashed(workspaceId: string, task: TaskRecord, err: unknown): void {
    const rt = this.runtimes.get(workspaceId);
    if (rt) rt.run = null;
    if (isTaskActive(task)) {
      transition(task, 'failed');
      task.outcome = 'failed';
      task.completedAt ??= this.now().toISOString();
      task.error ??= { code: 'internal_error', message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), retryable: true };
    }
    try {
      this.deps.store.putTask(task);
    } catch {
      // the store logs its own write failures
    }
    this.deps.onChange();
    this.deps.taskSettled?.(workspaceId);
  }

  private onClaudeEvent(workspaceId: string, task: TaskRecord, ev: ClaudeStreamEvent): void {
    const rt = this.runtimes.get(workspaceId);
    if (!rt) return;
    switch (ev.type) {
      case 'init':
        this.recordSession(workspaceId, task, ev.sessionId);
        break;
      case 'result':
        rt.resultSeen = true;
        if (ev.sessionId) this.recordSession(workspaceId, task, ev.sessionId);
        task.claudeResult = ev.result;
        if (ev.isError) task.error = { code: `claude_${ev.subtype}`, message: ev.result?.slice(0, 300) || `Claude reported ${ev.subtype}`, retryable: true };
        this.deps.store.putTask(task);
        break;
    }
  }

  private recordSession(workspaceId: string, task: TaskRecord, sessionId: string): void {
    task.claudeSessionIdAfter = sessionId;
    const ws = this.deps.store.workspace(workspaceId);
    // Only the owning Workspace's record is updated; a session id never crosses Workspaces.
    if (ws && ws.claudeSessionId !== sessionId && task.workspaceId === workspaceId) {
      this.deps.store.updateWorkspace(workspaceId, { claudeSessionId: sessionId });
      this.deps.onChange();
    }
  }

  private async finish(workspaceId: string, task: TaskRecord, before: GitSnapshot | null): Promise<void> {
    this.deps.store.putTask(task);
    this.deps.onChange();
    const ws = this.deps.store.workspace(workspaceId);
    if (!ws) return;
    const after = before?.isRepo ? await this.deps.git.snapshot(ws.projectPath, 'after', before.headSha ?? null).catch(() => null) : before;
    const rt = this.runtimes.get(workspaceId);
    if (!rt) return;
    const packet: ReviewPacket = {
      id: this.newId(),
      taskId: task.id,
      workspaceId,
      createdAt: this.now().toISOString(),
      body: buildReviewPacketBody({ projectName: ws.name, task, before, after }),
      deliveryStatus: 'pending',
      deliveryAttempts: 0,
      lastDeliveryError: null,
    };
    this.deps.store.putReviewPacket(packet);
    task.reviewPacketId = packet.id;
    transition(task, 'review_pending');
    this.deps.store.putTask(task);
    // A cancelled run does not replace an earlier completed result that is still waiting for review.
    const kept = rt.reviewTaskId ? this.deps.store.task(rt.reviewTaskId) : undefined;
    if (task.outcome !== 'cancelled' || kept?.status !== 'review_pending') rt.reviewTaskId = task.id;

    const outcome = task.outcome!;
    this.flow(workspaceId, 'claude_finished', outcome === 'succeeded' ? 'Claude finished' : `Claude ${outcome}`);
    const background = !this.deps.isForeground(workspaceId);
    rt.attention = outcome === 'succeeded' ? 'completed' : 'failed';
    if (!background && outcome === 'cancelled') rt.attention = 'none';
    this.deps.notifyTaskFinished({
      workspaceId,
      workspaceName: ws.name,
      taskId: task.id,
      kind: outcome === 'succeeded' ? 'success' : outcome === 'cancelled' ? 'info' : 'error',
      title: `${ws.name}: Claude ${outcome === 'succeeded' ? 'finished' : outcome}`,
      body: outcome === 'succeeded' ? 'Sending the result to ChatGPT…' : (task.error?.message ?? 'Review packet ready.'),
      background,
    });
    this.deps.onChange();
    this.deps.taskSettled?.(workspaceId);
    // A managed task that succeeded goes back to the conversation it came from, without a click (D040).
    if (outcome === 'succeeded')
      void this.deliverReview(workspaceId, task.id).then((r) => {
        if (r.ok || r.code !== 'in_progress') return;
        // Another delivery of this Workspace was still running: keep the result and offer Retry.
        const packet = this.deps.store.reviewPacket(task.reviewPacketId);
        if (!packet) return;
        packet.deliveryStatus = 'failed';
        packet.lastDeliveryError = 'Another delivery was still in progress.';
        this.deps.store.putReviewPacket(packet);
        this.deps.onChange();
      });
  }

  // ---------- Review handback (automatic; Retry only after a failure) ----------

  /** Manual Retry of a failed delivery. Re-sends the stored packet; Claude is never re-run. */
  async retryReview(workspaceId: string, taskId: string): Promise<OpResult> {
    const task = this.deps.store.task(taskId);
    const packet = task && this.deps.store.reviewPacket(task.reviewPacketId);
    if (!task || task.workspaceId !== workspaceId || !packet) return { ok: false, code: 'unknown_task', detail: 'Task not found in this Workspace' };
    if (packet.deliveryStatus !== 'failed') return { ok: false, code: 'not_failed', detail: 'Nothing to retry' };
    return this.deliverReview(workspaceId, taskId);
  }

  /**
   * Posts the task's review packet into the ChatGPT conversation the task started from (never into
   * whatever is visible), waits while the user is chatting there, and keeps the packet on any failure.
   */
  private async deliverReview(workspaceId: string, taskId: string): Promise<OpResult> {
    const rt = this.runtimes.get(workspaceId);
    const task = this.deps.store.task(taskId);
    if (!rt || !task || task.workspaceId !== workspaceId) return { ok: false, code: 'unknown_task', detail: 'Task not found in this Workspace' };
    if (task.status !== 'review_pending') return { ok: false, code: 'not_review_pending', detail: `Task is ${task.status}` };
    const packet = this.deps.store.reviewPacket(task.reviewPacketId);
    if (!packet) return { ok: false, code: 'no_packet', detail: 'Review packet missing' };
    if (rt.reviewSending) return { ok: false, code: 'in_progress', detail: 'Already sending' };
    rt.reviewSending = true;
    packet.deliveryAttempts += 1;
    this.deps.onChange();
    try {
      await this.postToSourceConversation(workspaceId, rt, task, packet.body);
      packet.deliveryStatus = 'sent';
      packet.lastDeliveryError = null;
      transition(task, 'review_sent');
      rt.attention = 'none';
      this.flow(workspaceId, 'review_sent', 'Result sent to ChatGPT');
      return { ok: true };
    } catch (err) {
      packet.deliveryStatus = 'failed';
      packet.lastDeliveryError = err instanceof HandbackError ? err.message : 'Unexpected error while sending to ChatGPT';
      // Task stays review_pending; Claude is never re-run.
      this.flow(workspaceId, 'review_failed', packet.lastDeliveryError);
      const ws = this.deps.store.workspace(workspaceId);
      if (ws) this.nudge(workspaceId, ws.name, 'Result delivery failed', packet.lastDeliveryError);
      return { ok: false, code: 'handback_failed', detail: packet.lastDeliveryError };
    } finally {
      rt.reviewSending = false;
      this.deps.store.putReviewPacket(packet);
      this.deps.store.putTask(task);
      this.deps.onChange();
    }
  }

  private async postToSourceConversation(workspaceId: string, rt: Runtime, task: TaskRecord, body: string): Promise<void> {
    const wait = this.deps.handbackWait ?? { intervalMs: 2_000, maxWaits: 90 };
    const stillHere = () => this.runtimes.get(workspaceId) === rt;
    const sleep = () => new Promise<void>((r) => setTimeout(r, wait.intervalMs));
    const chat = () => {
      if (!stillHere()) throw new HandbackError('The project was closed');
      const c = this.deps.chatFor(workspaceId);
      if (!c) throw new HandbackError('ChatGPT is not available in this Workspace');
      return c;
    };
    // The user may be chatting right now: let ChatGPT finish its reply first.
    for (let i = 0; rt.generating && i < wait.maxWaits; i++) await sleep();
    if (rt.generating) throw new HandbackError('ChatGPT is still responding. Retry when it finishes.');
    const conv = await chat().ensureConversation(task.sourceConversationUrl);
    if (!conv.ok)
      throw new HandbackError(
        conv.code === 'conversation_unavailable' ? 'Could not open the ChatGPT conversation this task came from.' : `ChatGPT is not ready (${conv.code})`,
      );
    for (let i = 0; ; i++) {
      const ins = await chat().insertComposerText(body);
      if (ins.ok) break;
      // A draft in the message box is the user's: wait for them to send it, never overwrite it.
      if (ins.code === 'composer_not_empty' && i < wait.maxWaits) {
        await sleep();
        continue;
      }
      throw new HandbackError(ins.code === 'composer_not_empty' ? 'The ChatGPT message box has text. Clear it, then retry.' : `Could not insert into ChatGPT (${ins.code})`);
    }
    const sub = await chat().submitComposer();
    if (!sub.ok) throw new HandbackError(sub.code === 'still_generating' ? 'ChatGPT is still responding. Retry when it finishes.' : `Could not submit to ChatGPT (${sub.code})`);
  }

  // ---------- Selection / views ----------

  /** Selecting a Workspace acknowledges its completion attention. Visibility only otherwise. */
  activate(workspaceId: string): void {
    const rt = this.runtimes.get(workspaceId);
    if (rt && rt.attention !== 'none') {
      rt.attention = 'none';
      this.deps.onChange();
    }
  }

  /** Workspaces whose managed Claude task is starting or running. */
  activeTaskWorkspaceIds(): string[] {
    return [...this.runtimes.keys()].filter((id) => {
      const rt = this.runtimes.get(id)!;
      return rt.sending || !!rt.run || isTaskActive(this.currentTask(id));
    });
  }

  attentionCount(): number {
    let n = 0;
    for (const rt of this.runtimes.values()) if (rt.attention !== 'none') n++;
    return n;
  }

  currentTask(workspaceId: string): TaskRecord | undefined {
    return this.deps.store.task(this.deps.store.workspace(workspaceId)?.lastTaskId);
  }

  view(workspaceId: string): WorkspaceView | null {
    const ws = this.deps.store.workspace(workspaceId);
    const rt = this.runtimes.get(workspaceId);
    if (!ws || !rt) return null;
    const task = this.currentTask(workspaceId);
    const cand = this.handoff.getCandidate(workspaceId);
    return {
      id: ws.id,
      name: ws.name,
      projectPath: ws.projectPath,
      color: ws.sidebarColor,
      initial: initialFor(ws.name),
      iconUrl: this.deps.iconFor?.(ws.id) ?? null,
      claudeSessionId: ws.claudeSessionId,
      model: ws.model ?? this.deps.defaultModel?.() ?? null,
      effort: ws.effort ?? null,
      splitRatio: this.deps.store.getSplitRatio(ws.id),
      viewMode: this.deps.store.getViewMode(ws.id),
      attention: rt.attention,
      chatgpt: { generating: rt.generating, loggedIn: rt.loggedIn },
      candidate: cand
        ? { text: cand.text, messageId: cand.messageId, alreadySent: !!task && sourcePrompt(task) === cand.text && task.outcome === 'succeeded' }
        : null,
      sending: rt.sending,
      autoSend: rt.autoSend ? { at: rt.autoSend.at } : null,
      autoSendNotice: rt.notice,
      task: task ? this.taskView(task, rt) : null,
      latestReview: this.latestReview(workspaceId, rt, task),
      terminal: rt.terminal,
    };
  }

  /** The completed result the user can still hand to ChatGPT; it survives a later task that is running. */
  private latestReview(workspaceId: string, rt: Runtime, current: TaskRecord | undefined): LatestReviewView | null {
    const kept = rt.reviewTaskId ? this.deps.store.task(rt.reviewTaskId) : undefined;
    const task = kept?.workspaceId === workspaceId && kept.status === 'review_pending' ? kept : current?.status === 'review_pending' ? current : undefined;
    const packet = task && this.deps.store.reviewPacket(task.reviewPacketId);
    if (!task || !packet) return null;
    return { taskId: task.id, status: rt.reviewSending ? 'sending' : packet.deliveryStatus, lastError: packet.lastDeliveryError, body: packet.body };
  }

  private taskView(task: TaskRecord, rt: Runtime): TaskView {
    const packet = this.deps.store.reviewPacket(task.reviewPacketId);
    return {
      id: task.id,
      status: task.status,
      outcome: task.outcome,
      prompt: task.prompt,
      createdAt: task.createdAt,
      error: task.error?.message ?? null,
      review: packet
        ? {
            status: rt.reviewSending ? 'sending' : packet.deliveryStatus,
            lastError: packet.lastDeliveryError,
            body: packet.body,
          }
        : null,
    };
  }

  // ---------- Flow log ("where did I leave off?") ----------

  /**
   * The user's own Claude turn ended in the terminal (Stop hook). Managed tasks log their own finish,
   * so this is only for runs the user typed or pasted themselves.
   */
  observeClaudeStop(workspaceId: string): void {
    const ws = this.deps.store.workspace(workspaceId);
    const rt = this.runtimes.get(workspaceId);
    if (!ws || !rt || rt.sending || rt.run || isTaskActive(this.currentTask(workspaceId))) return;
    this.flow(workspaceId, 'claude_finished', 'Claude finished (your own run)');
    this.nudge(workspaceId, ws.name, 'Claude finished', 'Your own run: not sent to ChatGPT.');
  }

  private promptReady(workspaceId: string, text: string, messageId: string | null): void {
    const ws = this.deps.store.workspace(workspaceId);
    if (!ws) return;
    // The same ChatGPT message re-observed (e.g. after a restart) is not a new event.
    const last = [...(ws.flowLog ?? [])].reverse().find((e) => e.kind === 'prompt_ready');
    if (last && (messageId ? last.messageId === messageId : last.detail === firstLine(text))) return;
    const task = this.currentTask(workspaceId);
    if (task && sourcePrompt(task) === text && task.outcome === 'succeeded') return; // already ran: not waiting on the user
    this.flow(workspaceId, 'prompt_ready', firstLine(text), messageId);
    this.nudge(workspaceId, ws.name, 'Claude Prompt ready', 'ChatGPT wrote a prompt that has not been sent to Claude yet.');
    const rt = this.runtimes.get(workspaceId);
    const pending = rt?.pendingIntent;
    if (rt && pending) {
      rt.pendingIntent = null;
      if (this.now().getTime() - pending.at < PENDING_INTENT_MS && this.autoSendEnabled()) return this.startAutoSend(workspaceId, rt, pending.requestId);
    }
    void this.maybeScheduleAutoSend(workspaceId, messageId, text);
  }

  // ---------- User-requested auto-send (D034) ----------

  private alreadyRan(workspaceId: string, text: string): boolean {
    const task = this.currentTask(workspaceId);
    return !!task && sourcePrompt(task) === text && task.outcome === 'succeeded';
  }

  claudePromptSuffix(): string {
    return this.deps.store.preferences().claudePromptSuffix;
  }

  setClaudePromptSuffix(text: string): void {
    this.deps.store.setPreferences({ claudePromptSuffix: text });
  }

  autoSendEnabled(): boolean {
    return this.deps.store.preferences().autoSendOnRequest;
  }

  /** Global on/off; turning it off cancels every pending countdown. */
  setAutoSendEnabled(on: boolean): void {
    this.deps.store.setPreferences({ autoSendOnRequest: on });
    if (on) return;
    for (const [id, rt] of this.runtimes) {
      rt.autoSendCheck = null;
      this.cancelAutoSend(id, rt);
    }
  }

  /** The user pressed Cancel on the countdown. */
  cancelAutoSendRequest(workspaceId: string): OpResult {
    const rt = this.runtimes.get(workspaceId);
    if (!rt?.autoSend) return { ok: false, code: 'no_auto_send', detail: 'Nothing is waiting to be sent' };
    this.cancelAutoSend(workspaceId, rt);
    return { ok: true };
  }

  /**
   * Poll hook: the user's own latest ChatGPT message is itself the trigger (D034). A message not seen
   * before that explicitly asks for the prompt to go to Claude starts the countdown right away with
   * the candidate already held, whatever ChatGPT is doing (no new block, no generating transition).
   * The first read of a Workspace is only a baseline, so old messages never fire after a restart.
   */
  async observeUserMessage(workspaceId: string): Promise<void> {
    const rt = this.runtimes.get(workspaceId);
    const chat = this.deps.chatFor(workspaceId);
    if (!rt || !chat) return;
    let res: AdapterResult<{ text: string; messageId: string | null }>;
    try {
      res = await chat.getLatestUserMessage();
    } catch {
      return;
    }
    if (this.runtimes.get(workspaceId) !== rt) return;
    if (!res.ok) {
      if (res.code === 'not_found' && rt.userMessageKey === undefined) rt.userMessageKey = ''; // an empty chat: the next message is new
      return;
    }
    const key = requestKey(res.value.messageId, res.value.text);
    const seenBefore = rt.userMessageKey;
    rt.userMessageKey = key;
    if (seenBefore === undefined || seenBefore === key) return;
    if (!this.autoSendEnabled() || !isSendToClaudeRequest(res.value.text)) return;
    this.startAutoSend(workspaceId, rt, key);
  }

  /**
   * A Sidekick command ("şimdi bunu claude gönder") was stopped in the ChatGPT composer before it was
   * submitted (D045). It is not a ChatGPT message: it goes through exactly the same auto-send path as a
   * message seen afterwards (candidate, countdown, duplicate protection, managed task).
   */
  observeInterceptedIntent(workspaceId: string, intent: { id: string }): void {
    const rt = this.runtimes.get(workspaceId);
    if (!rt) return;
    if (!this.autoSendEnabled()) return void this.setNotice(workspaceId, rt, NOTICE_DISABLED);
    this.startAutoSend(workspaceId, rt, `intercept:${intent.id}`);
  }

  /** The user asked to send: use the candidate held now, or tell them why that is not possible. */
  private startAutoSend(workspaceId: string, rt: Runtime, requestId: string): void {
    if (rt.autoSend) return; // a countdown is already running
    const cand = this.handoff.getCandidate(workspaceId);
    if (!cand) {
      // ChatGPT may still be writing the very prompt the user asked for: keep the request for it.
      if (!rt.generating && !rt.pendingCandidateKey) this.setNotice(workspaceId, rt, NOTICE_NO_PROMPT);
      else rt.pendingIntent = { requestId, at: this.now().getTime() };
      return;
    }
    const key = candidateKey(cand.messageId, cand.text);
    const pair = `${requestId}\u0000${key}`;
    if (rt.scheduledPairs.has(pair)) return;
    if (this.alreadyRan(workspaceId, cand.text)) {
      rt.scheduledPairs.add(pair);
      this.setNotice(workspaceId, rt, NOTICE_ALREADY_SENT);
      return;
    }
    if (this.taskBusy(workspaceId, rt)) {
      rt.scheduledPairs.add(pair);
      this.setNotice(workspaceId, rt, NOTICE_BUSY);
      return;
    }
    this.armAutoSend(workspaceId, rt, key, cand.messageId, pair);
  }

  /**
   * A new Claude Prompt is ready (first time this ChatGPT message is seen): if the user's own latest
   * message explicitly asked for it to go to Claude, send it after a cancellable countdown.
   */
  private async maybeScheduleAutoSend(workspaceId: string, messageId: string | null, text: string): Promise<void> {
    const rt = this.runtimes.get(workspaceId);
    const chat = this.deps.chatFor(workspaceId);
    if (!rt || !chat || !this.autoSendEnabled()) return;
    const key = candidateKey(messageId, text);
    rt.autoSendCheck = key;
    let request: string | null = null;
    let requestId: string | null = null;
    try {
      const res = await chat.getLatestUserMessage();
      request = res.ok ? res.value.text : null;
      requestId = res.ok ? requestKey(res.value.messageId, res.value.text) : null;
    } catch {
      request = null;
    }
    // Anything may have changed while ChatGPT was read.
    if (this.runtimes.get(workspaceId) !== rt || rt.autoSendCheck !== key) return;
    rt.autoSendCheck = null;
    if (!request || !requestId || !isSendToClaudeRequest(request) || !this.autoSendEnabled() || rt.autoSend) return;
    const pair = `${requestId}\u0000${key}`;
    if (rt.scheduledPairs.has(pair)) return;
    if (this.taskBusy(workspaceId, rt)) return;
    this.armAutoSend(workspaceId, rt, key, messageId, pair);
  }

  private taskBusy(workspaceId: string, rt: Runtime): boolean {
    return rt.sending || !!rt.run || isTaskActive(this.currentTask(workspaceId)) || !!this.deps.claudeBusy?.(workspaceId);
  }

  private armAutoSend(workspaceId: string, rt: Runtime, key: string, messageId: string | null, pair: string): void {
    const at = new Date(this.now().getTime() + AUTO_SEND_DELAY_MS).toISOString();
    const timer = setTimeout(() => void this.fireAutoSend(workspaceId, key, messageId), AUTO_SEND_DELAY_MS);
    rt.autoSend = { key, messageId, at, timer, waits: 0 };
    rt.scheduledPairs.add(pair);
    rt.notice = null;
    this.deps.onChange();
  }

  private async fireAutoSend(workspaceId: string, key: string, messageId: string | null): Promise<void> {
    const rt = this.runtimes.get(workspaceId);
    if (!rt || rt.autoSend?.key !== key) return;
    // ChatGPT is still replying: the prompt can only be captured once it is quiet, so wait for it.
    if (rt.generating && rt.autoSend.waits < AUTO_SEND_MAX_WAITS) {
      rt.autoSend.waits++;
      rt.autoSend.timer = setTimeout(() => void this.fireAutoSend(workspaceId, key, messageId), 1_000);
      return;
    }
    rt.autoSend = null;
    this.deps.onChange();
    if (!this.autoSendEnabled()) return;
    const cand = this.handoff.getCandidate(workspaceId);
    if (!cand) return void this.setNotice(workspaceId, rt, NOTICE_NO_PROMPT);
    if (candidateKey(cand.messageId, cand.text) !== key) return void this.setNotice(workspaceId, rt, NOTICE_CHANGED);
    const ws = this.deps.store.workspace(workspaceId);
    const res = await this.sendToClaude(workspaceId, 'auto_user_request', messageId);
    if (res.ok) {
      if (ws) this.nudge(workspaceId, ws.name, 'Sent to Claude', 'You asked ChatGPT to send the prompt to Claude.');
    } else if (this.runtimes.get(workspaceId) === rt) {
      this.setNotice(workspaceId, rt, noticeFor(res.code, res.detail));
    }
  }

  private setNotice(workspaceId: string, rt: Runtime, text: string): void {
    rt.notice = { text, at: this.now().toISOString() };
    if (this.runtimes.get(workspaceId) === rt) this.deps.onChange();
  }

  private cancelAutoSend(workspaceId: string, rt: Runtime): void {
    if (!rt.autoSend) return;
    clearTimeout(rt.autoSend.timer);
    rt.autoSend = null;
    if (this.runtimes.get(workspaceId) === rt) this.deps.onChange();
  }

  private flow(workspaceId: string, kind: FlowKind, detail: string, messageId: string | null = null): void {
    const ws = this.deps.store.workspace(workspaceId);
    if (!ws) return;
    this.deps.store.updateWorkspace(workspaceId, {
      flowLog: appendFlow(ws.flowLog, { at: this.now().toISOString(), kind, detail, ...(messageId ? { messageId } : {}) }),
    });
    this.deps.onChange();
  }

  private nudge(workspaceId: string, workspaceName: string, title: string, body: string): void {
    if (this.deps.isForeground(workspaceId)) return;
    this.deps.notifyFlow?.({ workspaceId, workspaceName, kind: 'info', title: `${workspaceName}: ${title}`, body });
  }
}

class HandbackError extends Error {}

const candidateKey = (messageId: string | null, text: string) => `${messageId ?? ''}\u0000${text}`;
/** A user message is identified by its ChatGPT id, or by its text when the page gives none. */
const requestKey = (messageId: string | null, text: string) => messageId ?? `text:${text}`;

const NOTICE_NO_PROMPT = 'No Claude prompt ready.';
const NOTICE_DISABLED = 'Auto-send is turned off in Settings.';
const NOTICE_BUSY = 'Claude is already working.';
const NOTICE_ALREADY_SENT = 'This prompt has already been sent.';
const NOTICE_CHANGED = 'Claude prompt changed. Please send again.';

/** User-facing text for a refused auto-send. */
function noticeFor(code: string, detail: string): string {
  switch (code) {
    case 'task_active':
    case 'claude_busy':
      return NOTICE_BUSY;
    case 'already_sent':
      return NOTICE_ALREADY_SENT;
    case 'candidate_changed':
      return NOTICE_CHANGED;
    case 'no_prompt_block':
    case 'no_assistant_messages':
    case 'view_unavailable':
      return NOTICE_NO_PROMPT;
    default:
      return detail;
  }
}

/** First non-empty line, shortened for the flow log. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}
