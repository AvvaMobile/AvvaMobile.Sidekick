# Sidekick Architecture

Status: Current implementation architecture. Decisions are recorded in [DECISIONS.md](DECISIONS.md); workflow in [WORKFLOW.md](WORKFLOW.md); security requirements in [SECURITY.md](SECURITY.md).

Terminology: **Sidekick** is the product (Avva Mobile Sidekick). A **Workspace** (shown to the user as a project tab) is one project context: a local folder, its own ChatGPT conversation, its own terminal Claude session and its task history (D031).

## 0. Product boundaries

Sidekick will:

- embed ChatGPT as a remote, isolated web surface with the user's normal login and voice mode;
- run the user's own interactive Claude Code in the Workspace's project folder;
- move a prompt from ChatGPT to Claude, and a bounded review packet back, only on an explicit user action (D005, D008, D034);
- keep several Workspaces alive at once and switch between them without reloading anything.

Sidekick will not reimplement ChatGPT or Claude Code, store ChatGPT or Anthropic credentials, forward the whole conversation to Claude, give remote content filesystem/shell/Node access, perform destructive Git actions, or use screen-coordinate automation. A Claude success message is not proof that the repository is correct; that is what the ChatGPT review is for.

## 1. High-level component model

- Electron main process
- local shell renderer (React) and a small local relay overlay renderer
- one ChatGPT WebContentsView per Workspace
- ChatGPT adapter
- Workspace orchestrator and handoff controller
- interactive Claude runner (terminal Claude + Stop hook)
- terminal service (node-pty)
- Git evidence service
- persistence service

Conceptual flow:

```
User (voice or text)
  -> ChatGPT WebContentsView
  -> designated Claude Prompt block (candidate)
  -> explicit Send to Claude (click, ⌘⇧↵, or the user's own explicit request, D034)
  -> HandoffController freezes the prompt into a Task
  -> InteractiveClaudeRunner pastes it into the terminal Claude and submits it
  -> Claude works in the project folder
  -> Claude Stop hook -> StopHookChannel -> task completes with Claude's last answer
  -> Git Evidence Service -> Review Packet (review_pending)
  -> user clicks Send to ChatGPT
  -> ChatGPT Adapter inserts and submits the packet
  -> ChatGPT review -> user
```

## 2. Process boundaries

### Main process

Owns all privileged capabilities: path validation, child processes, PTYs, Git, persistent data, BrowserWindow and WebContentsView creation, permission handlers and navigation policy. It never trusts values received from a renderer.

### Local renderers

The shell renderer and the relay overlay are packaged application code. They request narrow operations through preload IPC (open project picker, send to Claude, cancel, send review, terminal input/resize, …). There is no generic execute-shell API.

### ChatGPT remote view

Remote, untrusted content with no preload and no bridge. Sidekick interacts with it only from the main process through `ChatGPTAdapter`.

## 3. Shell composition

- **Tab strip** (`src/renderer/shell/components/TabBar.tsx`, D038): one tab per open Workspace, browser-style, reorderable by dragging, with a running/finished/failed badge. `+` opens the Projects start page, which lists saved Workspaces. Closing a tab keeps the saved Workspace.
- **Multiple windows** (`src/main/app/shellWindows.ts`, `ShellApp.ts`): right-click a tab → *Move to New Window* / *Move to Main Window*. Each open tab lives in exactly one window; each window has its own active tab, split layout and relay overlay. Runtimes (ChatGPT view, PTY, orchestrator) are shared and are never recreated by a move.
- **Work area**: ChatGPT on the left, the development pane (terminal Claude) on the right, with a draggable divider.
- **Relay overlay**: the two round buttons on the divider (*Send to Claude*, *Send to ChatGPT*) live in their own transparent local WebContentsView (`src/renderer/relay`, `src/preload/relay.ts`) so they can sit above the ChatGPT view. Clicks are accepted only from that window's relay view; the window's shell renderer performs the action for its active Workspace.

Each Workspace owns one ChatGPT WebContentsView that stays alive while the app runs. Only the active tab's view is visible and sized into the left region; others are hidden, never navigated or destroyed.

Split pane (D023): `src/domain/layout/splitPane.ts` is the single geometry source for renderer and main. `SplitLayoutController` keeps one ratio per Workspace, applies it on selection, resizes only via `setBounds`/`setVisible`, and persists on drag end. Live drag updates are fire-and-forget IPC, at most one per animation frame.

Do not use BrowserView or the webview tag.

## 4. Session partitioning

All ChatGPT views share one persistent partition (`persist:chatgpt`) so the user signs in once. Project/chat state is never derived from cookies: each Workspace stores its own ChatGPT conversation URL (only approved ChatGPT conversation routes are persisted).

## 5. ChatGPT adapter

`src/main/chatgpt/ChatGPTAdapter.ts` with page scripts in `pageScripts.ts`. Operations: conversation URL, latest designated Claude Prompt block, latest user message (for D034), insert composer text, submit, sign-in state.

Every operation runs in an isolated world, verifies the origin before and after, times out, returns a typed result, and never returns page HTML wholesale. No other component knows DOM selectors.

## 6. DOM resilience

ChatGPT's DOM is not a stable API. Rules: prefer semantic attributes and ARIA over generated class names; keep selectors in `pageScripts.ts`; cover observed page structures with fixtures (`pageScripts.test.ts`); detect unsupported states explicitly; never click unknown controls; never use screen coordinates; store no authentication material from the page.

Observed structures (2026): logged-in turns use `[data-content-search-unit-key]`; ChatGPT often answers "write a prompt for Claude" with a writing block (`[data-oai-writing-block-surface]`, markdown in `data-markdown-copy-text`); fenced blocks render as `[data-markdown-copy="code-block"]` with the language in a header and no `<pre>`; anonymous sessions use an older `ol[data-conversation-transcript] > li[data-message-role]` structure. The composer is a `contenteditable` inside the form (writing blocks excluded); the send button appears only when the composer has text. Candidate rules: D028/D032.

Sign-in workarounds: Electron/app tokens are stripped from the session user agent so identity providers see a normal Chromium UA; Google's `accounts.youtube.com` cookie-sync redirect and regional `accounts.google.<tld>` hosts are allowed as top-level auth navigations only.

## 7. Voice

Sidekick does not implement speech recognition; ChatGPT's own voice mode runs inside the ChatGPT view. The permission handler grants audio-only media to approved ChatGPT origins in the main frame and denies everything else. On macOS the system prompt is triggered only from the setup popup's Allow button (D037).

## 8. Claude execution (D033)

The right-hand terminal of every Workspace runs the user's own interactive `claude` in a node-pty PTY in the project folder, started as `claude --settings <hook settings> [--model …] [--effort …] [--resume <session>]` (model and effort come from the development pane shortcuts; changing either relaunches Claude Code in the same session). The `--settings` file only adds Sidekick's hooks; the user's own settings, permissions and status line apply unchanged. No permission-skipping flags are ever passed.

`InteractiveClaudeRunner` (`src/main/claude/InteractiveClaudeRunner.ts`) runs a managed task:

1. refuses if Claude is not running in that Workspace's terminal;
2. sanitizes the frozen prompt (control and escape characters removed) and writes it as one bracketed paste, then submits it with Enter;
3. correlates the turn through the `UserPromptSubmit` hook, so the task is bound to the turn its own prompt started;
4. completes only on the `Stop` hook event for that turn, taking Claude's last assistant message from the payload (or the transcript file) and the session id;
5. fails if the terminal Claude exits first. Cancel sends Escape to the terminal Claude.

`StopHookChannel` (`src/main/claude/StopHookChannel.ts`): the hook command drops one JSON payload per event into a per-Workspace directory (`<userData>/hook-events/<workspaceId>`), written atomically (temporary file, then rename); the main process watches that directory. On Windows the hook is a PowerShell script referenced from a settings file, so it works under Git Bash and PowerShell alike.

PTY output and keystrokes never change task state; only hook events do.

## 9. Claude session policy

- One Claude session per Workspace, owned by the terminal Claude.
- The session id is learned from the terminal Claude (Stop hook payload) and persisted on the Workspace.
- When the terminal starts again it resumes that session; *New Claude session* starts a fresh one.
- A Workspace never resumes another Workspace's session.

## 10. Development pane

| Concern | Module |
| --- | --- |
| Electron glue, windows, IPC, menu, notifications | `src/main/app/ShellApp.ts`, `src/main/app/shellWindows.ts` |
| Per-Workspace orchestration (candidate, task, auto-send, review, attention) | `src/main/app/WorkspaceOrchestrator.ts` |
| Prompt freeze boundary | `src/main/orchestration/HandoffController.ts` |
| Persisted AppState | `src/main/app/AppStateStore.ts` (`<userData>/workspace-state.json`) |
| Claude runner and hooks | `src/main/claude/InteractiveClaudeRunner.ts`, `StopHookChannel.ts`; executable resolution in `ClaudeRunner.ts` |
| Git evidence | `src/main/git/GitEvidence.ts` |
| Terminal | `src/main/terminal/PtyService.ts` (node-pty), `src/renderer/shell/terminals.ts` (xterm.js) |
| Review packet | `src/domain/review/reviewPacket.ts` |
| Auto-send detection | `src/domain/handoff/autoSend.ts` |
| Shell UI | `src/renderer/shell/*` (React); relay overlay `src/renderer/relay/*` |
| Updates, setup check | `src/main/app/updater.ts`, `src/main/app/setupCheck.ts` |

The right-hand pane is the Workspace's terminal running Claude (xterm.js on node-pty). Its header has **Clear** (`/clear`), **Copy** (copies the code of Claude's last completed response from the Stop hook's `last_assistant_message`, never terminal text and never `/copy`: one fenced block → its body; several → a menu; none → the full response; ▾ = full response; D040), the model switch, the effort level, **Stop** while a task runs, and **⋯** (*New Claude session*). A sub-header shows the project path and Claude session. The relay buttons sit on the divider, not in the header; only the auto-send countdown is shown in the pane (review handback is the relay button).

Managed activity is not rendered into the terminal: only Claude itself writes there (rendering into it would corrupt Claude's screen).

Isolation (D022): ChatGPT activity never writes to the terminal, sends input to a PTY, starts Claude or changes task state. ChatGPT/adapter/IPC/navigation/permission diagnostics go to the diagnostics log, never to a renderer surface. ChatGPT-side modules must not import the development pane, PTY, terminal or orchestration modules (enforced by `src/__tests__/isolationBoundaries.test.ts`). The only ChatGPT → Claude path is `HandoffController.sendToClaude()`.

## 11. Orchestrator state machine

```
draft -> queued -> running -> succeeded | failed | cancelled -> review_pending -> review_sent
```

A task running during an unclean shutdown is marked `interrupted` on restart.

On task completion:

1. freeze Claude's result
2. collect Git evidence
3. create and persist the ReviewPacket, mark `review_pending`
4. notify the user
5. wait for the user's click on *Send to ChatGPT*
6. insert and submit the packet into that Workspace's ChatGPT conversation
7. mark `review_sent`

If sending fails, the task stays `review_pending` and can be retried without rerunning Claude.

## 12. Git evidence service

Before and after a task: branch, HEAD sha, `git status --short`. After: `git diff --stat`, changed file names, a bounded diff excerpt that skips secret-like files. Only read-only Git commands are used; never reset, clean, checkout, rebase, merge or push to gather evidence.

## 13. Review packet size

Bounded, in priority order: task metadata, Claude's final answer, changed file names, diff stat, warnings, diff excerpt. Long content is cut with an explicit truncation marker. The full Claude transcript is never sent.

## 14. IPC design

`contextBridge` from local preload scripts exposes typed, narrow APIs only. Never exposed: `ipcRenderer`, `fs`, `child_process`, shell execution, Electron session objects or arbitrary channel names. The main process validates the sender and the input of every handler.

## 15. Persistence

`<userData>/workspace-state.json` (`AppStateStore`): schema version, Workspaces (id, name, project path, tab order and open state, ChatGPT conversation URL, Claude session id, split ratio, optional custom icon in `<userData>/icons`), bounded task history (20 per Workspace), review packets, active Workspace and global preferences (auto-send, one-time popups). Atomic writes, migration hook, recovery from a corrupt file, no credentials. Runtime objects (views, PTYs, processes) are never persisted.

The user-data folder is `<appData>/AvvaMobile.Sidekick` (D035); `SIDEKICK_USER_DATA` overrides it.

## 16. Concurrency

At most one managed task per Workspace at a time; different Workspaces may run tasks concurrently. Every process, hook event and task event is keyed by Workspace id and task id.

## 17. Packaging

See D036 and [RELEASING.md](RELEASING.md): electron-builder, GitHub Releases of this repository, electron-updater. Platform specifics (Claude executable resolution, hook command, title bar) stay out of domain logic.

## 18. Workspace runtimes

The main process keeps runtime objects per Workspace id: the ChatGPT WebContentsView and its navigation state, the Claude terminal PTY, the orchestrator (task, candidate, review and attention state).

1. Saved Workspaces are restored at startup; open tabs are initialized so switching is instant.
2. Switching tabs, or moving a tab to another window, changes visibility only; it never destroys a runtime.
3. Runtimes are disposed only when the user closes a Workspace tab or quits.

## 19. Prompt candidate extraction

`ChatGPTAdapter` returns only the latest designated Claude Prompt block (D017, D028, D032), never concatenated conversation text. A block becomes the candidate only after two identical consecutive observations, so a block still being written never enables *Send to Claude*.

## 20. Notifications

Task events map to:

- the tab badge (running / finished / failed)
- an in-app toast
- an OS notification when the Workspace is not the one in front
- Dock bounce and badge count on macOS

Activating a notification selects the owning Workspace tab (in its window) without recreating its ChatGPT view or terminal.

## 21. Configuration

Settings are minimal; the user never configures what Sidekick can detect. No passwords or API keys are stored.

- Claude executable is resolved automatically (login-shell `PATH`); `SIDEKICK_CLAUDE_PATH` overrides it.
- Approved ChatGPT/OpenAI origins live only in `src/main/security/origins.ts`, with tests.
- Environment variables: `SIDEKICK_USER_DATA`, `SIDEKICK_DEVELOPER` (Developer menu), `SIDEKICK_NO_UPDATES`, `SIDEKICK_CLAUDE_PATH`, `SIDEKICK_DIAG_CONSOLE` (diagnostics to stdout). Older `WORKSPACE_*` names still work.
