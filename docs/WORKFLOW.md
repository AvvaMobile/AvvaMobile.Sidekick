# Sidekick Workflow

Status: Current workflow specification. "Sidekick" is the product; a "Workspace" is one project context, shown as a tab (D031, D038).

## 1. Normal workflow

### Step 1: Create or select a Workspace

For a new Workspace, the user provides:

- project name
- local working directory

Sidekick persists the Workspace record, opens it as a tab and starts its runtime (ChatGPT view, terminal Claude).

Saved Workspaces are listed on the Projects start page (`+`); open ones are tabs in the tab strip. Selecting a tab changes visibility only; it does not reload ChatGPT or restart the terminal Claude.

### Step 2: Plan with ChatGPT

The user talks with ChatGPT, normally using voice.

This phase can last as many turns as required.

Nothing is sent to Claude Code during planning; only a click on a block's *Send to Claude* button delegates (D046).

### Step 3: Produce the implementation prompt

The user asks ChatGPT to produce the final prompt for Claude Code.

The final implementation prompt is rendered by ChatGPT as a distinct copyable fenced/code block (or writing block). Sidekick injects a *Send to Claude* button right after that block's Copy button; every prompt/code block has its own.

### Step 4: Explicitly delegate

The user clicks the *Send to Claude* button of the block they want to delegate. Sidekick reads the text of exactly that block (never another block, never stored text) and freezes it into a Task. The button shows *Sent to Claude ✓* only after Claude reports (`UserPromptSubmit`) that it received the prompt; otherwise it shows *Send failed — Retry* with the reason.

### Step 5: Execute with Claude Code

The right-hand terminal always runs the user's interactive `claude` in the project folder (D033). Sidekick pastes the frozen prompt into it (control characters removed, one bracketed paste) and submits it. The user watches Claude work in that terminal as usual.

The task completes when Claude's `Stop` hook reports the end of the turn that the prompt started.

### Step 6: Gather evidence

When the turn ends, Sidekick records:

- success/failure/cancel state
- Claude final result
- Claude session id
- Git status
- changed files
- diff stat
- relevant test/build evidence when available

### Step 7: Automatic ChatGPT review (D044)

When a managed task succeeds, Sidekick creates and persists a bounded review packet and, without a click, inserts and submits it into the ChatGPT conversation the task came from (the conversation recorded when the task was sent, in that Workspace). If the user moved to another conversation meanwhile, Sidekick navigates back to the source one first; if that is impossible it does not guess.

Manual Claude turns (typed in the terminal) are not managed tasks and are never handed back. If delivery fails, the packet is kept and a compact Retry appears; Claude is never rerun.

The packet asks ChatGPT to review the implementation critically.

### Step 8: Continue

The user discusses the result with ChatGPT.

The next cycle may:

- accept the work
- ask for fixes
- ask for tests
- ask for a new implementation prompt
- reset/start a new Claude session

## 2. Delegation safety

Only explicit delegation creates a task.

Valid triggers:

- click a block's Send to Claude button

Invalid triggers:

- ChatGPT simply emits a code block
- ChatGPT mentions Claude
- a DOM selector happens to match a button
- terminal becomes idle
- a previous task finishes

## 3. Prompt rules

The prompt is exactly the text of the clicked block.

Sidekick must not silently:

- append the full conversation
- prepend unrelated history
- rewrite requirements
- infer missing acceptance criteria
- include credentials

Control and escape characters are removed before the prompt is pasted, so text in a ChatGPT reply cannot type extra keys into Claude.

## 4. Voice

There is no voice or text command that sends a prompt to Claude (removed, D046). ChatGPT's voice mode only helps plan; delegating is always a click on a block's button.

## 5. Claude permissions

Sidekick never adds permission-skipping Claude Code flags.

The terminal Claude uses the user's own Claude Code configuration and permissions. If Claude asks for approval, the user answers in the terminal as usual.

If later versions introduce permission automation, that is a separate security decision.

## 6. Review handback behavior

When a managed task succeeds, Sidekick builds the review packet and delivers it to the originating ChatGPT conversation automatically (D044). It waits while ChatGPT is replying or a draft is in the message box, and never overwrites a draft. There is no *Send to ChatGPT* button.

If ChatGPT cannot accept the packet (conversation unavailable, page not ready, insertion failed):

- keep task review_pending
- retain the packet
- show "Result delivery failed" with a compact Retry (the only manual action)
- do not rerun Claude

## 7. Cancellation

The user may cancel a running task.

Cancel (Stop in the pane header) sends Escape to the terminal Claude, which interrupts its current turn. Cancellation:

- records cancelled state
- keeps Claude's session and terminal output
- does not mark the task as failed

## 8. Restart recovery

After an application restart:

- no previous child process is assumed to still exist
- open Workspace tabs reopen from persisted metadata and their terminal Claude resumes the saved session
- a task that was running during an unclean shutdown is marked interrupted
- saved review_pending packets remain retryable
- Claude session ids remain available for future resume if valid

## 9. Multi-project switching behavior

Several Workspaces are alive at once. Switching tabs:

- hides the previous Workspace surfaces
- shows the selected Workspace surfaces
- updates the window title to the selected project name
- preserves ChatGPT page/conversation state
- preserves Claude session/task state
- preserves the terminal Claude process and buffer

No normal project switch may trigger reload, remount-driven state loss or process/session recreation.

Claude tasks in inactive Workspaces continue running.

When a Workspace that is not in front completes a task, its tab gets a badge and Sidekick shows an in-app toast and an OS notification.

Activating that notification selects the Workspace instantly.

## 10. Separate windows

Right-click a tab → *Move to New Window* moves that Workspace into its own window (*Move to Main Window* moves it back). Moving is a visibility change only: the ChatGPT view, terminal Claude and task state are kept. Each window has its own active tab and split.

## 11. Manual use of the same Claude

The terminal Claude is the user's normal Claude Code session: the user can type to it directly at any time, before, between or after delegated prompts.

Only a delegated prompt creates a task. Manual turns do not; keystrokes and terminal output are never task evidence. A task completes only on the `Stop` hook of the turn its own prompt started (correlated through the `UserPromptSubmit` hook).

## 12. Completion attention behavior

Implementation: tab badge (running / finished / failed), in-app toast (click selects the Workspace), OS notification when the Workspace is not the one in front (click selects it), Dock bounce and badge count on macOS while attention is pending. Selecting the Workspace clears attention. A result that could not be delivered stays available for Retry.

When a task completes:

1. mark the owning Workspace as requiring attention
2. show an in-app completion notification
3. issue an OS notification where permission allows
4. use Dock attention/badge behavior on macOS
5. if the user activates the notification, select that Workspace
6. clear attention only after the completion result has been visited/acknowledged
