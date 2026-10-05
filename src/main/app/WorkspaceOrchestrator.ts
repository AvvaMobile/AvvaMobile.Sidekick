import { randomUUID } from 'node:crypto';
import { buildReviewPacketBody, type GitSnapshot, type ReviewPacket } from '../../domain/review/reviewPacket';
import { sanitizeTerminalPrompt } from '../../domain/prompt/promptText';
import { isTaskActive, newTask, transition, type TaskRecord } from '../../domain/task/task';
import { initialFor } from '../../domain/workspace/workspace';
import type { AttentionState, LatestReviewView, TaskView, WorkspaceView } from '../../shared/state';
import type { AdapterResult } from '../chatgpt/ChatGPTAdapter';
import type { ClaudeRunHandle, ClaudeRunnerPort, ClaudeStreamEvent } from '../claude/ClaudeRunner';
import { CLAUDE_BUSY_MESSAGE } from '../claude/InteractiveClaudeRunner';
import type { DevelopmentPaneRegistry } from '../development/DevelopmentPane';
import type { GitEvidencePort } from '../git/GitEvidence';
import type { ModelChoice } from '../../shared/models';
import type { AppStateStore } from './AppStateStore';

/** What the orchestrator needs from a Workspace's ChatGPT adapter. */
export interface ChatPort {
  insertComposerText(text: string): Promise<AdapterResult<{ inserted: number }>>;
  submitComposer(): Promise<AdapterResult<{ via: string }>>;
  /** Makes sure the view shows the conversation a result belongs to (restoring it if the user moved on); never guesses. */
  ensureConversation(url: string | null): Promise<AdapterResult<{ restored: boolean }>>;
  /** Whether ChatGPT is writing a reply right now (the handback waits for it). */
  getPageState(): Promise<AdapterResult<{ generating: boolean }>>;
  /** Conversation the view shows now (the source of a block send). */
  getConversationUrl?(): string | null;
}

/** Outcome of one click on a block's "Send to Claude" button, shown on that button. */
export interface BlockSendStatus {
  id: string;
  /** started = Claude reported (UserPromptSubmit) that it received exactly this prompt. */
  state: 'started' | 'failed';
  detail: string;
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

/** A finished result could not be delivered while the window is in the background. */
export type FlowNotice = Omit<TaskFinishedNotice, 'taskId' | 'background'>;

export interface OrchestratorDeps {
  store: AppStateStore;
  panes: DevelopmentPaneRegistry;
  runner: ClaudeRunnerPort;
  git: GitEvidencePort;
  chatFor(workspaceId: string): ChatPort | null;
  isForeground(workspaceId: string): boolean;
  notifyTaskFinished(notice: TaskFinishedNotice): void;
  /** Background-only notice: the automatic handback failed and waits for Retry. */
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
  /** Shows a block button's outcome (ChatGPT page). */
  blockSendStatus?(workspaceId: string, status: BlockSendStatus): void;
  newId?: () => string;
  now?: () => Date;
}

interface Runtime {
  loggedIn: boolean | null;
  attention: AttentionState;
  run: ClaudeRunHandle | null;
  cancelRequested: boolean;
  resultSeen: boolean;
  reviewSending: boolean;
  /** Task whose review packet the user can hand to ChatGPT: the latest completed result, independent of a task that is running now. */
  reviewTaskId: string | null;
  /** A block send is starting a task (blocks double clicks). */
  sending: boolean;
  terminal: { running: boolean; error: string | null };
  /** The block-button click whose task has not been confirmed started by Claude yet. */
  blockSend: { id: string; started: boolean } | null;
}

export type OpResult = { ok: true } | { ok: false; code: string; detail: string };

/**
 * Per-Workspace orchestration: block "Send to Claude" click -> managed run -> evidence -> review packet ->
 * automatic handback to the originating conversation (WORKFLOW §1, D024, D040).
 *
 * Every piece of state is keyed by workspaceId. The only way a task starts is the user's click on one
 * ChatGPT block's own button; nothing here is driven by terminal/PTY activity or by ChatGPT output.
 */
export class WorkspaceOrchestrator {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  register(workspaceId: string): void {
    if (this.runtimes.has(workspaceId)) return;
    this.deps.panes.ensure(workspaceId);
    this.failInterruptedDelivery(workspaceId);
    this.runtimes.set(workspaceId, {
      loggedIn: null,
      attention: 'none',
      run: null,
      cancelRequested: false,
      resultSeen: false,
      reviewSending: false,
      reviewTaskId: null,
      sending: false,
      terminal: { running: false, error: null },
      blockSend: null,
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
    rt?.run?.cancel();
    this.runtimes.delete(workspaceId);
    this.deps.panes.dispose(workspaceId);
  }

  /** Application shutdown: stop every managed Claude process (tasks are marked interrupted on next start). */
  shutdown(): void {
    for (const rt of this.runtimes.values()) {
      rt.cancelRequested = true;
      rt.run?.cancel();
    }
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

  // ---------- Send to Claude (block button) ----------

  /**
   * The "Send to Claude" button of one prompt/code block was clicked: `req.text` is that block's own text and the
   * only source of the prompt. Success is reported only once Claude confirms it received the prompt
   * (`submitted`); every refusal or later failure before that is reported back to the same button.
   */
  async sendBlockToClaude(workspaceId: string, req: { id: string; text: string; messageId: string | null }): Promise<void> {
    const report = (detail: string) => this.deps.blockSendStatus?.(workspaceId, { id: req.id, state: 'failed', detail });
    try {
      const res = await this.startBlockTask(workspaceId, req);
      if (!res.ok) report(res.detail);
    } catch (err) {
      report(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
    }
  }

  private async startBlockTask(workspaceId: string, req: { id: string; text: string; messageId: string | null }): Promise<OpResult> {
    const ws = this.deps.store.workspace(workspaceId);
    const rt = this.runtimes.get(workspaceId);
    if (!ws || !rt) return { ok: false, code: 'unknown_workspace', detail: 'Workspace not found' };
    if (rt.sending || rt.run || isTaskActive(this.currentTask(workspaceId))) return { ok: false, code: 'task_active', detail: 'Claude is already working.' };
    // Never queue behind a turn already running in the terminal: its Stop would be mistaken for ours.
    if (this.deps.claudeBusy?.(workspaceId)) return { ok: false, code: 'claude_busy', detail: CLAUDE_BUSY_MESSAGE };
    const chat = this.deps.chatFor(workspaceId);
    if (!chat) return { ok: false, code: 'view_unavailable', detail: 'ChatGPT is not ready in this Workspace' };
    // The prompt is pasted into the terminal: no control characters or escape sequences (ChatGPT output).
    const prompt = sanitizeTerminalPrompt(req.text);
    if (!prompt.trim()) return { ok: false, code: 'empty_block', detail: 'This block is empty' };
    const task = newTask({
      id: this.newId(),
      workspaceId,
      prompt,
      sourceConversationUrl: chat.getConversationUrl?.() ?? null,
      sourceAssistantMessageId: req.messageId,
      claudeSessionIdBefore: ws.claudeSessionId,
      now: this.now().toISOString(),
    });
    this.deps.store.putTask(task);
    this.deps.store.updateWorkspace(workspaceId, { lastTaskId: task.id });
    rt.cancelRequested = false;
    rt.resultSeen = false;
    rt.attention = 'none';
    // Placeholder handle so nothing else can start before the process exists.
    rt.run = { cancel: () => (rt.cancelRequested = true) };
    rt.blockSend = { id: req.id, started: false };
    this.deps.onChange();
    void this.run(workspaceId, task).catch((err: unknown) => this.crashed(workspaceId, task, err));
    return { ok: true };
  }

  /** The block-button task ended without Claude ever confirming the prompt: tell its button. */
  private failBlockSend(workspaceId: string, rt: Runtime, detail: string): void {
    const b = rt.blockSend;
    if (!b || b.started) return;
    rt.blockSend = null;
    this.deps.blockSendStatus?.(workspaceId, { id: b.id, state: 'failed', detail });
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
      this.failBlockSend(workspaceId, rt, 'Cancelled before Claude started');
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
        if (live.blockSend && !live.blockSend.started) {
          this.failBlockSend(workspaceId, live, live.cancelRequested || exit.cancelled ? 'Cancelled before Claude started' : (exit.spawnError ?? 'Claude did not confirm receiving the prompt'));
        }
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
    if (rt) {
      rt.run = null;
      this.failBlockSend(workspaceId, rt, 'Unexpected error while starting Claude');
    }
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
      case 'submitted':
        if (rt.blockSend && !rt.blockSend.started) {
          rt.blockSend.started = true;
          this.deps.blockSendStatus?.(workspaceId, { id: rt.blockSend.id, state: 'started', detail: 'Claude received this block and started working' });
        }
        break;
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
      return { ok: true };
    } catch (err) {
      packet.deliveryStatus = 'failed';
      packet.lastDeliveryError = err instanceof HandbackError ? err.message : 'Unexpected error while sending to ChatGPT';
      // Task stays review_pending; Claude is never re-run.
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
    const replying = async () => {
      const st = await chat().getPageState();
      return st.ok && st.value.generating;
    };
    for (let i = 0; i < wait.maxWaits && (await replying()); i++) await sleep();
    if (await replying()) throw new HandbackError('ChatGPT is still responding. Retry when it finishes.');
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
      chatgpt: { loggedIn: rt.loggedIn },
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

  // ---------- Failure notice ----------

  private nudge(workspaceId: string, workspaceName: string, title: string, body: string): void {
    if (this.deps.isForeground(workspaceId)) return;
    this.deps.notifyFlow?.({ workspaceId, workspaceName, kind: 'info', title: `${workspaceName}: ${title}`, body });
  }
}

class HandbackError extends Error {}
