# Sidekick Architecture Decisions

This file records decisions that should not be rediscovered during implementation. Superseded decisions are kept for history and marked as such.

## D001 - Electron for Phase 1

Decision:
Use Electron.

Reason:
The application needs remote Chromium content, multiple desktop windows, local process control and terminal integration. Electron minimizes the number of technology boundaries for the first version.

## D002 - Product name Workspace

Decision:
The desktop product is named Workspace.

Repository name remains AvvaMobile.AgentTeams unless changed separately (renamed to AvvaMobile.Sidekick by D035).

Superseded by D031 (product name; "Workspace" now means one project context).

## D003 - ChatGPT is the planning/review brain

Decision:
Workspace does not attempt to replace ChatGPT planning with a local orchestrator model.

The user's normal ChatGPT conversation is the primary planning interface.

## D004 - Claude Code is the implementation worker

Decision:
Workspace delegates explicit implementation prompts to Claude Code.

The implementation boundary is intentionally clear.

## D005 - Explicit handoff only

Decision:
No continuous conversation mirroring from ChatGPT to Claude.

Reason:
The user wants to think freely with ChatGPT and only delegate the final deliberate prompt.

## D006 - Structured Claude execution

Decision:
Managed Claude tasks use print/structured output rather than scraping an interactive terminal prompt.

Reason:
Reliable lifecycle, parseable result, session id and deterministic completion.

Superseded by D033.

## D007 - Terminal remains visible

Decision:
Managed execution remains visible in the development pane.

An interactive PTY terminal is also available for manual use.

Superseded by D033.

## D008 - Approval-gated review handback

Decision:
Claude completion produces a local review packet and notifies the user. Workspace asks whether it should be sent to ChatGPT. Only user approval causes insertion/submission to ChatGPT.

Reason:
The user wants the copy/paste step eliminated without losing control over when Claude's result becomes a new ChatGPT turn.

## D009 - WebContentsView

Decision:
Use WebContentsView for embedded ChatGPT.

Do not start new implementation on deprecated BrowserView or the discouraged webview tag.

## D010 - Voice provided by ChatGPT in Phase 1

Decision:
Workspace does not build speech recognition initially.

The embedded ChatGPT voice experience is the first voice implementation.

## D011 - Single shell with persistent project runtimes first

Decision:
The primary Phase 1 UX is one application shell with a Slack-style project sidebar. Every initialized WorkspaceRuntime stays loaded in the background. Selecting another project hides the previous project's views and shows the selected project's views without reload or recreation.

Separate windows remain an optional future/presentation capability, not the primary navigation model.

Superseded by D038.

## D012 - Feasibility before polish

Decision:
Prove ChatGPT login, voice, capture and insertion securely before spending time on full UI polish.

## D013 - Security boundary

Decision:
Remote ChatGPT content receives no local privileged bridge.

All privileged operations are initiated from trusted local UI/orchestration code.

## D014 - Minimal Workspace creation

Decision:
Creating a Workspace requires a project name and a local working directory.

The selected working directory is the default root for Claude Code and the manual terminal.

## D015 - Instant switching, no reload

Decision:
Normal Workspace switching is hide/show only.

A switch must not reload ChatGPT, recreate WebContentsView, restart Claude/PTY processes, reset terminal buffers or recreate sessions.

Reason:
The product is intended to operate five or more projects in parallel with effectively instant context switching.

## D016 - Colored project sidebar

Decision:
The far-left project sidebar is narrow and dark. Each Workspace has a persistent colored icon, initially generated from the project name/initial.

The selected project, running state and attention/completion state must be visually distinguishable.

Superseded by D038.

## D017 - Claude Prompt block contract

Decision:
A prompt intended for Claude is rendered by ChatGPT as a distinct copyable fenced/code block. Send to Claude targets the most recent designated Claude Prompt block, not the entire conversation and not an arbitrary assistant response.

## D018 - Send to Claude has voice and button paths

Decision:
The same delegation command can be invoked from a visible button or a narrowly recognized explicit voice command after feasibility is proven.

Both routes freeze and send exactly the same prompt candidate.

## D019 - One default Claude session per Workspace

Decision:
Each Workspace keeps one persistent Claude session by default. The user can explicitly create/reset to a new session. Multiple parallel Claude sessions inside the same Workspace are not a Phase 1 default.

## D020 - Manual terminal remains interactive

Decision:
The user may type directly into the right-hand terminal and intervene manually. Managed Claude completion detection must remain independent from PTY prompt scraping.

## D021 - Completion notification layers

Decision:
When Claude completes, Workspace signals completion through the project sidebar, an in-app notification and macOS notification/Dock attention where available. Activating the notification navigates to the relevant Workspace without reloading it.

Since D038 the sidebar signal is the tab badge.

## D022 - ChatGPT activity and the development pane are isolated

Decision:
Normal ChatGPT activity (typing, sending messages, streaming replies, navigation, permission checks, adapter calls, DOM observation) never writes to the development pane, never sends input to a PTY, never starts Claude, never creates a Task and never changes Claude session state or any terminal buffer.

The development pane (right column) changes only for:

- A. explicit user keystrokes into the manual terminal (sent to that Workspace's PTY; the echo comes back as PTY output)
- B. an explicit Send to Claude action (button or recognized voice command)
- C. output of a managed Claude process
- D. output of a command intentionally launched from the terminal
- E. deliberate, user-facing Workspace system messages that belong to the pane

The development pane is not an application debug console. ChatGPT view / adapter / IPC / navigation / permission diagnostics go to the internal diagnostics log (`src/main/diagnostics/diagnosticsLog.ts`: bounded file under userData, optional stdout with `SIDEKICK_DIAG_CONSOLE=1`), never to a renderer surface.

Enforcement:

- `DevelopmentPaneRegistry` accepts output only from typed sources (`pty`, `managed-claude`, `workspace-system`), per Workspace, with no generic log entry point.
- `HandoffController` is the only ChatGPT -> Claude path; DOM observation can only update the candidate preview.
- `src/__tests__/isolationBoundaries.test.ts` fails if ChatGPT-side modules import the development pane, PTY, xterm or orchestration, or push events to a renderer.

Reason:
M0 regression: the spike's right panel received every ChatGPT navigation/permission event through an `m0:log` push channel, so chatting with ChatGPT visibly wrote into the Claude/terminal side.

## D023 - Resizable split, persisted per Workspace

Decision:
A draggable vertical splitter separates the ChatGPT and development columns. Minimum widths: ChatGPT 360 px, development pane 320 px, splitter 6 px. The split ratio is stored per Workspace (`WorkspaceUiState.splitRatio`) and restored when that Workspace is selected. Five layout presets (Terminal only, GPT 20/80, 50/50, 80/20, GPT only) sit at the right end of the tab strip and act on the window's active Workspace; the mode is stored per Workspace (`WorkspaceUiState.layoutMode`, absent in older records = `custom`, so saved ratios keep working). Presets are ratios clamped to the minimum widths; dragging the splitter switches the Workspace to `custom`. Hidden panes are only hidden (ChatGPT view `setVisible(false)`, terminal frame `visibility:hidden` at its normal size), never destroyed or resized to zero.

Geometry is computed by one pure module (`src/domain/layout/splitPane.ts`) used by both the renderer and the main process. During a drag the renderer updates its own layout immediately and sends at most one fire-and-forget ratio update per animation frame; the main process only calls `setBounds` on the existing ChatGPT WebContentsView. The ratio is persisted on drag end only.

Resizing never reloads, navigates or recreates the ChatGPT view, never restarts a PTY or Claude process and never resets a session or buffer. No animation.

## D024 - Send to Claude is a two-step trusted-shell action with preview

Decision:
Send to Claude lives in the trusted local shell (development pane header), never in the remote ChatGPT view. It operates only on the latest designated Claude Prompt block of the selected Workspace.

1. Passive observation (polling the selected Workspace every second, others every few seconds) only updates that Workspace's candidate preview and the button state.
2. Click (or ⌘⇧↵): capture the block fresh, show a preflight preview with exactly that text.
3. Confirm: freeze exactly the previewed text into a Task (single-use preflight id; a running task blocks further sends), then start the managed runner in that Workspace's directory, resuming that Workspace's Claude session.

Reason:
The user must see the exact prompt before execution; duplicate clicks or later ChatGPT output must never change or duplicate a task.

Superseded by D029.

## D025 - Adapter diagnostics are development-only

Decision:
The ChatGPT adapter diagnostic controls (first built for the M0 feasibility harness) are not product UI. In the product shell they exist only behind Developer → Diagnostics (off by default) and the main process refuses diagnostic IPC calls while the switch is off.

The separate M0 harness (`--m0` entry point) was later removed from the codebase; the in-app Developer → Diagnostics panel remains.

## D026 - Managed Claude activity and manual terminal are separate surfaces

Decision:
The development pane has two modes per Workspace: Claude (structured activity transcript of managed tasks, rendered from stream-json) and Terminal (xterm.js on a node-pty login shell started in the Workspace directory). They share no buffer and no lifecycle: terminal input/output never changes task state, and task completion comes only from the Claude `result` event plus process exit. Each Workspace keeps its own xterm instance, PTY process, buffers and mode; switching Workspaces only changes visibility.

Superseded by D029 and D033.

## D027 - Claude permissions use the user's configuration

Decision:
Managed runs use `claude -p --output-format stream-json --verbose [--resume <session>]` with the prompt on stdin and no permission flags. Tools Claude was not allowed to use are reported from `permission_denials` in the activity transcript and the review packet (WORKFLOW §5).

Superseded by D033 (the principle stands: the user's own permission configuration, no permission flags).

## D028 - Designated Claude Prompt: fenced block or Claude-titled writing block

Decision:
Besides a ```` ```claude-prompt ```` fenced block, a ChatGPT writing block whose title mentions "Claude" (or whose label is `claude-prompt`) is a designated Claude Prompt block. Its markdown text (`data-markdown-copy-text`) is the candidate. A newly seen block becomes the candidate only after two consecutive identical observations (about 1 s apart), so a block that is still being written never enables Send to Claude.

Reason:
In the 2026 logged-in UI, ChatGPT answers "write a prompt for Claude" with a titled writing block rather than a fenced code block. Preview + explicit confirmation (D024) still guard execution.

## D029 - One-click Send to Claude, terminal-only development pane (supersedes parts of D024 and D026)

Decision (user direction, 2026-10-01):

- Send to Claude is a single click (or ⌘⇧↵): capture the latest designated Claude Prompt block fresh, freeze it into a Task and start Claude immediately. There is no preview/confirm step.
- The right pane is the Workspace terminal only. Managed Claude output (prompt header, assistant text, tool calls/results, final result, status lines) is rendered into that Workspace's terminal stream, after stripping all terminal control/escape sequences from untrusted text. There is no separate Claude activity view or Claude/Terminal toggle.

Safeguards kept:

- The button is enabled only for a stable designated block (D028) of the selected Workspace, never while a task runs or a send is in progress; concurrent clicks start at most one task.
- A prompt identical to the last successfully completed task's prompt is refused ("already run"); a failed task's prompt can be re-run.
- Managed completion still comes only from the Claude `result` event + process exit; PTY input/output never changes task state (D020).
- Review handback remains approval-gated (D008): a compact bar above the terminal offers "Send to ChatGPT for review" / "Retry review".

## D030 - Prompt detection fallback: plain-text block in a reply that hands work to Claude

Decision:
If an assistant reply contains no designated block (D017/D028) but its prose — text outside code/writing blocks — mentions Claude (e.g. "Claude'a bunu ver:"), its last plain-text/markdown code block (`Plain text`, `text`, `markdown`, `prompt` or unlabeled) is the Claude Prompt candidate. Code blocks in any other language are never used. The 2026 UI renders fenced blocks as `[data-markdown-copy="code-block"]` (no `<pre>`) with the language label in the header; both forms are supported.

Reason:
ChatGPT often answers "send this to Claude" with an untagged plain-text block. The prompt shown in the terminal at start, the stable-candidate rule and the "already run" guard remain.

## D031 - Product name Avva Mobile Sidekick (supersedes D002's product name)

Decision:
The desktop product is named **Avva Mobile Sidekick** and uses the Avva Mobile logo as its app icon (`build/icon.svg` source, `build/icon.png`, `build/icon.icns`). "Workspace" remains the term for one project context (sidebar entry with its own ChatGPT view, terminal and Claude session). The user-data folder stays `~/Library/Application Support/Workspace` so existing Workspaces and the ChatGPT login survive the rename (superseded by D035: moved to `AvvaMobile.Sidekick`).

Development: `npm run app` launches `.dev/Avva Mobile Sidekick.app`, an APFS clone of the stock Electron.app with the product name, bundle id `com.avvamobile.sidekick.dev` and icon, re-signed ad hoc (`scripts/dev-bundle.cjs`, rebuilt only when Electron or the icon changes). Dock, app switcher and menu bar therefore show the product name in development too. Because the bundle id differs from stock Electron, macOS asks again for microphone/notification permission once.

## D032 - Any ChatGPT box is a prompt candidate (supersedes D028's title rule and D030)

Decision:
Per assistant reply, newest first: a tagged block wins (```` ```claude-prompt ```` fence/label, or a writing block titled with Claude/`claude-prompt`); otherwise the reply's last "box" is the candidate — any writing block regardless of title (its markdown, with a single outer ```` ``` ```` fence removed), or a plain-text/markdown/unlabeled code block. Code blocks in a programming language (bash, ts, …) are never candidates. A later reply without a box keeps the earlier prompt as the candidate.

Reason:
ChatGPT titles its boxes freely ("Workspace Repository Sync and Status Audit Prompt") and rarely mentions Claude; requiring the word "Claude" kept Send to Claude disabled. The user's explicit click, the prompt header printed in the terminal and the "already run" guard (D029) remain the safeguards.

## D033 - The terminal always runs interactive Claude Code (supersedes the `claude -p` runner of D027/D029)

The right-hand terminal of every Workspace starts `claude --settings <Stop hook> [--resume <session>]` (not a login shell), so the user's own Claude settings, status line footer and permissions apply. Restart starts a fresh session. Send to Claude pastes the frozen prompt into that Claude and submits it (`InteractiveClaudeRunner`); completion comes only from the Claude `Stop` hook, which drops a JSON payload into a per-Workspace directory (`<userData>/hook-events/<id>`, `StopHookChannel`). Cancel sends Escape. Managed activity is no longer rendered into the terminal (it would corrupt Claude's screen); evidence, review packet and handback are unchanged.

## D034 - Auto-send when the user asks ChatGPT to send the prompt to Claude

Decision:
When a new Claude Prompt becomes ready (first time its ChatGPT message is seen, D032 rules) and the user's own latest ChatGPT message explicitly asks for it to go to Claude ("bu promptu Claude'a gönder", "send this to Claude", voice spellings like "Klod'a ilet"), the prompt is sent through the normal Send to Claude path (trigger `auto_user_request`) after a 3-second countdown shown in the development pane with a Cancel button. Detection is a conservative pure function (`src/domain/handoff/autoSend.ts`): imperative send verbs only; negation, deferral or condition words near the phrase ("gönderme", "önce", "ama", "don't", "not yet", "later", "if") reject it. The countdown is cancelled when the candidate changes or disappears, ChatGPT starts writing again, the user sends manually, the Workspace closes or the setting is turned off. A ChatGPT message is never auto-sent twice, and messages already seen before a restart never auto-send. Global setting Workspace → "Auto-send when I ask ChatGPT", default on, persisted in `preferences.autoSendOnRequest`.

Reason:
The user's own message is explicit delegation (SECURITY §16); ChatGPT output alone still never launches Claude. Prefer false negatives: the button remains the fallback.

## D035 - Project identifiers renamed to AvvaMobile.Sidekick

Decision:
Everything that identifies the project uses **AvvaMobile.Sidekick**: the GitHub repository (`AvvaMobile/AvvaMobile.Sidekick`, formerly `AvvaMobile.AgentTeams`), the local folder, the npm package name (`avvamobile.sidekick`) and the user-data folder (`<appData>/AvvaMobile.Sidekick`). The display name stays **Avva Mobile Sidekick** (D031) and the bundle/app user model id stays `com.avvamobile.sidekick`.

On first launch, if `<appData>/AvvaMobile.Sidekick` does not exist and the pre-rename `<appData>/Workspace` does, the old folder is moved (renamed) to the new location, so Workspaces, the ChatGPT login and logs are kept. `SIDEKICK_USER_DATA` / `SIDEKICK_DEVELOPER` replace `WORKSPACE_USER_DATA` / `WORKSPACE_DEVELOPER`; the old variables still work.

## D036 - Packaging, release channel and auto-update

Decision:
electron-builder (`electron-builder.yml`) produces macOS DMG + zip for arm64 and x64 (hardened runtime, Developer ID signing and notarization — on the release Mac via `npm run release:mac` while the certificate stays in its keychain, or in CI when the signing secrets are present) and a Windows x64 NSIS one-click per-user installer (unsigned until a certificate exists; SmartScreen shows "unknown publisher"). node-pty is unpacked from app.asar and uses its bundled N-API prebuilds (`npmRebuild: false`). Releases are published as GitHub Releases of the (now public) `AvvaMobile/AvvaMobile.Sidekick` repository; a `vX.Y.Z` tag runs `.github/workflows/release.yml`: draft release, macOS and Windows builds upload into it, then it is published. The installed app uses electron-updater (`UpdateService`): it checks on launch and every 4 hours, downloads in the background, asks once per version "Restart Now / Later" and otherwise installs on quit. "Check for Updates…" is in the app menu (macOS) or Help (Windows). Development runs never check; `SIDEKICK_NO_UPDATES=1` disables checks in a packaged build.

Reason:
One release flow for both platforms, no build tooling on user machines, and updates without exposing source. macOS auto-update requires a signed app, so unsigned local builds cannot self-update.

## D037 - First-launch requirements popup

Decision:
On first launch, a one-time "Before you start" popup lists what the app needs: Claude Code (installed and signed in), a ChatGPT account and Git, each with a download/open link (`SETUP_LINKS` in `src/shared/setup.ts`), plus the microphone permission for ChatGPT voice. It checks immediately on opening ("Check again" re-runs): `claude --version` (resolved like the terminal does) and `git --version` in the login-shell environment; ChatGPT shows signed in when any open Workspace reports it. The microphone is no longer requested automatically at startup: the popup's Allow button asks (macOS, first time) or opens the OS privacy settings after a denial. Shown once (`preferences.setupPromptShown`, also for existing installs) and again from Help → Setup Checklist…. The one-time coffee popup moved to the next launch (never in the same launch as this popup).

Reason:
Packaged installs (D036) reach users who may lack the CLI tools; asking for the microphone on an explicit click is clearer than an unexplained system prompt at launch.

## D038 - Tab strip and movable windows replace the project sidebar (supersedes D011 and D016)

Decision:
Open Workspaces are shown as browser-style tabs in a tab strip at the top of the window (`src/renderer/shell/components/TabBar.tsx`), not in a sidebar. Tabs are reordered by dragging and carry a badge for running / finished / failed. `+` opens the Projects start page, which lists all saved Workspaces; closing a tab keeps the saved Workspace.

A tab can be moved into its own window (right-click → Move to New Window, and back with Move to Main Window). Each open tab lives in exactly one window; each window has its own active tab, split layout and relay overlay, and its renderer sees only its own tabs (`src/main/app/shellWindows.ts`). Runtimes (ChatGPT view, terminal Claude, orchestrator) are shared and never recreated by switching or moving tabs, so D015 still holds.

Reason:
Tabs show project names instead of initials and scale better; separate windows let projects sit side by side on several screens.

## D039 - Public repository, MIT license

Decision:
The `AvvaMobile/AvvaMobile.Sidekick` repository is public and licensed under MIT (`LICENSE`, "Copyright (c) 2026 Avva Mobile"). Internal planning documents (master plan, phase plans, roadmap, the M0 feasibility report, early configuration/data-model/integration specs) were removed; anything still accurate moved into `docs/ARCHITECTURE.md`. Local working notes (`.run/`, `DEVELOPMENT-PROMPT.md`) are not tracked. Releases and the auto-update feed are the GitHub Releases of this repository (D036). Vulnerabilities are reported privately through GitHub (`.github/SECURITY.md`).

Reason:
Users install and update from public releases built from public source, so they can verify what they run.

## D040 - Copy uses Claude's final response, not the terminal

Decision:
The development pane's Copy copies from the last completed Claude response of the Workspace (Stop hook `last_assistant_message`, transcript fallback), kept in memory by `ResponseCopier` and written to the clipboard by the main process. Fenced Markdown blocks (backtick/tilde, CommonMark closing rules, list indentation stripped) are parsed from that raw text (`src/domain/response/codeBlocks.ts`): one block → its body only (no fences, label or prose); several → a menu (Code block N — language, Full response); none → the full response; ▾ always offers "Copy full response". Copy never writes `/copy` to the terminal, never scrapes terminal output and works while a task runs.

Reason:
Terminal text carries renderer decorations and wrapping, so selecting code there is unreliable. The raw response keeps the fences and language labels exactly (verified from the transcript).

## D041 - A managed run always ends; the toolbar follows the run, not the session

Decision:
A managed Claude task (`InteractiveClaudeRunner`) ends only from hook and process signals, never from terminal output: the `Stop` hook after our prompt was acknowledged, the user's Escape / Ctrl+C in the terminal (`StopHookChannel.interrupt` → task `cancelled`), the terminal process ending or being replaced (`PtyService.relaunch`/`restartIn` now notify exit listeners), or no `UserPromptSubmit` for our prompt while Claude is idle for 30 s (task fails). The renderer's STOP, and every control that depends on a running task, derives from the task status, which is final as soon as the run ends.
The latest completed result (`WorkspaceView.latestReview`) is independent of the active task: it stays available for Send to ChatGPT while a later task runs, a later success replaces it, a later cancelled task does not. Copy works from the last response regardless of a running task.
Clear keeps its purpose (`/clear` clears Claude's context) and is disabled only while a managed task runs: typed mid-turn it would be queued into that turn. Model and effort can be changed while a task runs; the choice is stored at once and the terminal's Claude is relaunched (same session) only when nothing is running any more (`DeferredRelaunch`).

Reason:
Interrupting with Escape/Ctrl+C ends a Claude turn without a `Stop` event, and a relaunch hid the old process's exit, so a run could wait forever: STOP stayed, and the toolbar (disabled whenever a task "ran") stayed locked.

## D042 - GitHub repository is metadata; access is verified explicitly, with a temporary token source

Decision:
A Workspace may carry `githubRepository` (`owner/repo`, normalized from `owner/repo`, github.com URLs or `git@github.com:` remotes) and a last-known `githubAccess` (`status`, optional `permission`, `checkedAt`). Saving the repository needs no authentication. If it was never set (`undefined`), Project Settings best-effort prefills it from the folder's `origin` remote (`git remote get-url origin`, fixed arguments); a saved or user-cleared (`null`) value is never touched, and a prefill is never verified automatically.
"Verify access" (and one automatic check after saving) calls `GET /repos/{owner}/{repo}` and maps the result to `accessible` (+ read/triage/write/maintain/admin), `no-access`, `not-found`, `auth-required` or `error`. Without a token the state is `auth-required`, never a guess. Changing or clearing the repository clears `githubAccess`; a result that arrives after the repository changed is dropped. The saved status is a hint only: an explicit verify always re-checks. No shell command is ever built from the repository value.
Current authentication mechanism (temporary): `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`. This is a stopgap, not the intended end-user experience; a product-quality GitHub connection flow (for example OAuth) may replace it, and only `defaultGithubToken` needs to change.

Reason:
Syntactic validity proves nothing about access, and permissions change. Reusing an existing login avoids new auth architecture until a real connection flow is designed.
