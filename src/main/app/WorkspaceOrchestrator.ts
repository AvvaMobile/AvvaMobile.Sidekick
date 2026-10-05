import { randomUUID } from 'node:crypto';
import { buildReviewPacketBody, type GitSnapshot, type ReviewPacket } from '../../domain/review/reviewPacket';
import { appendFlow } from '../../domain/flow/flow';
import { AUTO_SEND_DELAY_MS, isSendToClaudeRequest } from '../../domain/handoff/autoSend';
import { isTaskActive, newTask, transition, type TaskRecord } from '../../domain/task/task';
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
  /** ChatGPT message id of the last user request that started a countdown (one countdown per request). */
  lastAutoSendRequestId: string | null;
  /** Scheduled user-requested auto-send (D034). */
  autoSend: { key: string; messageId: string | null; at: string; timer: ReturnType<typeof setTimeout> } | null;
}

export type OpResult = { ok: true } | { ok: false; code: string; detail: string };

/**
 * Per-Workspace orchestration: candidate prompt -> explicit Send to Claude -> managed run ->
 * evidence -> review packet -> user-approved handback (WORKFLOW §1, D005, D008, D024).
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
      lastAutoSendRequestId: null,
      autoSend: null,
    });
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
    } else if (res.code === 'no_prompt_block' || res.code === 'no_assistant_messages') {
      rt.generating = false;
      this.handoff.observeCandidate(workspaceId, null);
    } else if (res.code === 'wrong_origin' || res.code === 'view_unavailable') {
      rt.generating = false;
      this.handoff.observeCandidate(workspaceId, null);
    }
    // timeout/script_error: keep the previous state (transient).
    // A pending auto-send only survives while exactly that prompt stays ready and ChatGPT is quiet.
    const cand = this.handoff.getCandidate(workspaceId);
    const candKey = cand ? candidateKey(cand.messageId, cand.text) : null;
    if (rt.autoSendCheck && (rt.generating || rt.autoSendCheck !== candKey)) rt.autoSendCheck = null;
    if (rt.autoSend && (rt.generating || rt.autoSend.key !== candKey)) this.cancelAutoSend(workspaceId, rt);
    if (!wasGenerating && rt.generating) this.flow(workspaceId, 'chatgpt_started', 'ChatGPT started writing');
    // A reply only counts as finished when ChatGPT was actually read again (not when the view vanished).
    else if (wasGenerating && !rt.generating && (res.ok || res.code === 'no_prompt_block' || res.code === 'no_assistant_messages')) {
      this.flow(workspaceId, 'chatgpt_replied', 'ChatGPT finished its reply');
      // "Send this prompt to Claude" about a prompt that was already there: ChatGPT replied without a
      // new block, so promptReady will not fire. A new block still settling is left to promptReady.
      if (cand && !rt.pendingCandidateKey && !this.alreadyRan(workspaceId, cand.text)) void this.maybeScheduleAutoSend(workspaceId, cand.messageId, cand.text);
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
    try {
      const res = await this.handoff.send(workspaceId, chat, trigger);
      if (!res.ok) return res;
      // Auto-send only ever sends the very ChatGPT message the user's request was about.
      if (expectMessageId !== undefined && res.task.sourceMessageId !== expectMessageId)
        return { ok: false, code: 'candidate_changed', detail: 'The Claude Prompt changed before it was sent' };
      const last = this.currentTask(workspaceId);
      // Without a preview step, one click must not silently re-run work that already succeeded.
      if (last && last.prompt === res.task.prompt && last.outcome === 'succeeded')
        return { ok: false, code: 'already_sent', detail: 'This Claude Prompt was already run successfully. Ask ChatGPT for a new prompt.' };
      frozen = res.task;
    } finally {
      rt.sending = false;
    }
    if (!this.runtimes.has(workspaceId) || !this.deps.store.workspace(workspaceId)) return { ok: false, code: 'unknown_workspace', detail: 'Workspace removed' };
    const task = newTask({
      id: frozen.taskId,
      workspaceId,
      prompt: frozen.prompt,
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
      body: outcome === 'succeeded' ? 'Review packet ready. Send it to ChatGPT?' : (task.error?.message ?? 'Review packet ready.'),
      background,
    });
    this.deps.onChange();
    this.deps.taskSettled?.(workspaceId);
  }

  // ---------- Review handback (user-approved only) ----------

  async sendReview(workspaceId: string, taskId: string): Promise<OpResult> {
    const rt = this.runtimes.get(workspaceId);
    const task = this.deps.store.task(taskId);
    if (!rt || !task || task.workspaceId !== workspaceId) return { ok: false, code: 'unknown_task', detail: 'Task not found in this Workspace' };
    if (task.status !== 'review_pending') return { ok: false, code: 'not_review_pending', detail: `Task is ${task.status}` };
    const packet = this.deps.store.reviewPacket(task.reviewPacketId);
    if (!packet) return { ok: false, code: 'no_packet', detail: 'Review packet missing' };
    if (rt.reviewSending) return { ok: false, code: 'in_progress', detail: 'Already sending' };
    const chat = this.deps.chatFor(workspaceId);
    rt.reviewSending = true;
    packet.deliveryAttempts += 1;
    this.deps.onChange();
    try {
      if (!chat) throw new HandbackError('ChatGPT is not available in this Workspace');
      const ins = await chat.insertComposerText(packet.body);
      if (!ins.ok)
        throw new HandbackError(
          ins.code === 'composer_not_empty' ? 'The ChatGPT message box already has text. Clear it, then retry.' : `Could not insert into ChatGPT (${ins.code})`,
        );
      const sub = await chat.submitComposer();
      if (!sub.ok) throw new HandbackError(sub.code === 'still_generating' ? 'ChatGPT is still responding. Retry when it finishes.' : `Could not submit to ChatGPT (${sub.code})`);
      packet.deliveryStatus = 'sent';
      packet.lastDeliveryError = null;
      transition(task, 'review_sent');
      rt.attention = 'none';
      this.flow(workspaceId, 'review_sent', 'Review sent to ChatGPT');
      return { ok: true };
    } catch (err) {
      packet.deliveryStatus = 'failed';
      packet.lastDeliveryError = err instanceof HandbackError ? err.message : 'Unexpected error while sending to ChatGPT';
      // Task stays review_pending; Claude is never re-run.
      this.flow(workspaceId, 'review_failed', packet.lastDeliveryError);
      return { ok: false, code: 'handback_failed', detail: packet.lastDeliveryError };
    } finally {
      rt.reviewSending = false;
      this.deps.store.putReviewPacket(packet);
      this.deps.store.putTask(task);
      this.deps.onChange();
    }
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
        ? { text: cand.text, messageId: cand.messageId, alreadySent: !!task && task.prompt === cand.text && task.outcome === 'succeeded' }
        : null,
      sending: rt.sending,
      autoSend: rt.autoSend ? { at: rt.autoSend.at } : null,
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
    this.nudge(workspaceId, ws.name, 'Claude finished', 'ChatGPT has not heard back yet.');
  }

  private promptReady(workspaceId: string, text: string, messageId: string | null): void {
    const ws = this.deps.store.workspace(workspaceId);
    if (!ws) return;
    // The same ChatGPT message re-observed (e.g. after a restart) is not a new event.
    const last = [...(ws.flowLog ?? [])].reverse().find((e) => e.kind === 'prompt_ready');
    if (last && (messageId ? last.messageId === messageId : last.detail === firstLine(text))) return;
    const task = this.currentTask(workspaceId);
    if (task && task.prompt === text && task.outcome === 'succeeded') return; // already ran: not waiting on the user
    this.flow(workspaceId, 'prompt_ready', firstLine(text), messageId);
    this.nudge(workspaceId, ws.name, 'Claude Prompt ready', 'ChatGPT wrote a prompt that has not been sent to Claude yet.');
    void this.maybeScheduleAutoSend(workspaceId, messageId, text);
  }

  // ---------- User-requested auto-send (D034) ----------

  private alreadyRan(workspaceId: string, text: string): boolean {
    const task = this.currentTask(workspaceId);
    return !!task && task.prompt === text && task.outcome === 'succeeded';
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
      requestId = res.ok ? res.value.messageId : null;
    } catch {
      request = null;
    }
    // Anything may have changed while ChatGPT was read.
    if (this.runtimes.get(workspaceId) !== rt || rt.autoSendCheck !== key) return;
    rt.autoSendCheck = null;
    if (!request || !isSendToClaudeRequest(request) || !this.autoSendEnabled() || rt.autoSend) return;
    // Without a stable id the request cannot be deduplicated: the button stays the way to send.
    if (!requestId || requestId === rt.lastAutoSendRequestId) return;
    if (rt.generating || rt.sending || rt.run || isTaskActive(this.currentTask(workspaceId))) return;
    const at = new Date(this.now().getTime() + AUTO_SEND_DELAY_MS).toISOString();
    const timer = setTimeout(() => void this.fireAutoSend(workspaceId, key, messageId), AUTO_SEND_DELAY_MS);
    rt.autoSend = { key, messageId, at, timer };
    rt.lastAutoSendRequestId = requestId;
    this.deps.onChange();
  }

  private async fireAutoSend(workspaceId: string, key: string, messageId: string | null): Promise<void> {
    const rt = this.runtimes.get(workspaceId);
    if (!rt || rt.autoSend?.key !== key) return;
    rt.autoSend = null;
    this.deps.onChange();
    const cand = this.handoff.getCandidate(workspaceId);
    if (!this.autoSendEnabled() || rt.generating || !cand || candidateKey(cand.messageId, cand.text) !== key) return;
    const ws = this.deps.store.workspace(workspaceId);
    const res = await this.sendToClaude(workspaceId, 'auto_user_request', messageId);
    if (res.ok && ws) this.nudge(workspaceId, ws.name, 'Sent to Claude', 'You asked ChatGPT to send the prompt to Claude.');
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

/** First non-empty line, shortened for the flow log. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}
