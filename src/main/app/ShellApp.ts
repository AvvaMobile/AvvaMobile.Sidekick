import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  Notification,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  WebContentsView,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nodePty from 'node-pty';
import { autoUpdater } from 'electron-updater';
import { DEFAULT_SPLIT_RATIO, isValidSplitRatio } from '../../domain/layout/splitPane';
import { isViewMode } from '../../domain/layout/viewMode';
import { isEffortChoice, isModelChoice, parseDefaultModel, type ModelChoice } from '../../shared/models';
import { colorForName, initialFor, isOpen, validateWorkspaceName, type WorkspaceRecord } from '../../domain/workspace/workspace';
import type { AppSettings, ProjectSettings, SettingsTarget } from '../../shared/settings';
import { isSetupLink, SETUP_LINKS, type SetupCheck } from '../../shared/setup';
import { TOPBAR_HEIGHT, workAreaFor } from '../../shared/shellLayout';
import { BUY_ME_A_COFFEE_URL, SHELL_CHANNELS, type ProjectEntry, type ShellCommand, type ShellState, type ToastMessage } from '../../shared/state';
import { ChatGPTAdapter, MAX_PROMPT_CHARS } from '../chatgpt/ChatGPTAdapter';
import { InteractiveClaudeRunner } from '../claude/InteractiveClaudeRunner';
import { isClaudeSessionId, launchCommand, loginShellEnv, resolveClaudeExecutable } from '../claude/ClaudeRunner';
import { StopHookChannel, hookSettings } from '../claude/StopHookChannel';
import { DeferredRelaunch } from './DeferredRelaunch';
import { ResponseCopier } from './ResponseCopier';
import { DevelopmentPaneRegistry } from '../development/DevelopmentPane';
import { createDiagnosticsLog } from '../diagnostics/diagnosticsLog';
import { GitEvidence } from '../git/GitEvidence';
import { CHATGPT_HOME_URL, CHATGPT_PARTITION, conversationUrlToStore, isChatGptConversationUrl } from '../security/origins';
import { createChatGptView, redactUrl, redactUrlsIn } from '../security/remoteContent';
import { PtyService } from '../terminal/PtyService';
import { SplitLayoutController } from '../workspace/SplitLayoutController';
import { AppStateStore } from './AppStateStore';
import { validateAppSettingsPatch, validateProjectSettingsPatch } from './settingsValidation';
import { isSamePage, mergeWindowOrder, nextActiveTab, stateForWindow } from './shellWindows';
import { prefillGithubRepository } from '../github/gitRemote';
import { defaultGithubToken, setGithubRepository, verifyWorkspaceGithub } from '../github/GithubAccessChecker';
import { UpdateService } from './updater';
import { checkTool, microphoneSettingsUrl, microphoneStatus } from './setupCheck';
import { ICON_EXTENSIONS, WorkspaceIcons } from './WorkspaceIcons';
import { WorkspaceOrchestrator, type TaskFinishedNotice } from './WorkspaceOrchestrator';

interface ChatRuntime {
  view: WebContentsView;
  adapter: ChatGPTAdapter;
}

/** One shell window: its own tab selection (split layout). */
interface ShellWindow {
  win: BrowserWindow;
  layout: SplitLayoutController;
}

const POLL_MS = 1000;
const INACTIVE_EVERY = 5;
const LOGIN_CHECK_EVERY = 5;

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const isCopyBlock = (v: unknown): v is { block: number } => typeof v === 'object' && v !== null && typeof (v as { block?: unknown }).block === 'number';
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v);

/**
 * Phase 1 product shell: project tab strip, per-Workspace ChatGPT WebContentsView (left),
 * draggable splitter, development pane (right). Wires the domain/orchestration modules to Electron.
 */
export async function startShell(): Promise<{ focusMainWindow: () => void }> {
  const userData = app.getPath('userData');
  const diag = createDiagnosticsLog(join(userData, 'diagnostics', 'events.log'));
  const store = new AppStateStore(join(userData, 'workspace-state.json'));
  const panes = new DevelopmentPaneRegistry();
  const stopHooks = new StopHookChannel(join(userData, 'hook-events'));
  const responses = new ResponseCopier(clipboard, (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });
  const icons = new WorkspaceIcons(join(userData, 'icons'));
  const chats = new Map<string, ChatRuntime>();
  let defaultModel: ModelChoice | null = null;
  try {
    defaultModel = parseDefaultModel(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {
    // no user settings: Claude Code's built-in default applies
  }
  // Developer → Diagnostics; SIDEKICK_DEVELOPER=1 (or WORKSPACE_DEVELOPER=1) starts with it enabled (development only).
  let debugMode = process.env.SIDEKICK_DEVELOPER === '1' || process.env.WORKSPACE_DEVELOPER === '1';

  // ---------- Windows ----------
  // Every open tab lives in exactly one shell window; the first window is the main window. Each window has
  // its own split layout (active tab) and relay overlay; runtimes (ChatGPT view, PTY, orchestrator) are shared.

  const windows = new Map<number, ShellWindow>();
  const windowOf = new Map<string, ShellWindow>();
  let quitting = false;

  // The only page the shell window ever shows (dev server in development, the bundled file otherwise).
  const shellPageUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/shell/index.html`
    : pathToFileURL(join(__dirname, '../renderer/shell/index.html')).href;
  const isShellPage = (url: string) => isSamePage(url, shellPageUrl);

  const loadShellRenderer = async (sw: ShellWindow) => {
    // loadURL/loadFile are main-initiated and never pass through the will-navigate guard.
    if (process.env.ELECTRON_RENDERER_URL) await sw.win.loadURL(shellPageUrl);
    else await sw.win.loadFile(join(__dirname, '../renderer/shell/index.html'));
  };

  function createShellWindow(bounds?: Rectangle): ShellWindow {
    const win = new BrowserWindow({
      width: 1500,
      height: 940,
      ...bounds,
      minWidth: 900,
      minHeight: 560,
      title: 'Avva Mobile Sidekick',
      // The tab strip doubles as the title bar: traffic lights sit inside it and its empty space drags the window.
      // The ChatGPT view starts below the strip, so the strip's drag region never overlaps it (a drag region over
      // the view makes macOS swallow clicks on ChatGPT controls, e.g. its sidebar toggle).
      // Windows: same hidden title bar; the native caption buttons are overlaid on the strip's right end
      // (colors match the strip; one pixel short so its bottom border stays visible).
      ...(isWindows
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#f9f9f9', symbolColor: '#1f1f1f', height: TOPBAR_HEIGHT - 1 },
            autoHideMenuBar: true,
          }
        : { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } }),
      backgroundColor: '#16181c',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/shell.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    win.once('ready-to-show', () => win.show());
    // The shell renderer never navigates or opens windows itself (e.g. a dropped file or link).
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const layout = new SplitLayoutController(
      store,
      () => {
        const [w, h] = win.getContentSize();
        return workAreaFor(w!, h!);
      },
    );
    const sw: ShellWindow = { win, layout };
    windows.set(win.id, sw);

    // In full screen the traffic lights disappear, so the strip needs no room for them.
    win.on('enter-full-screen', () => sendCommand(sw, 'fullscreen-enter'));
    win.on('leave-full-screen', () => sendCommand(sw, 'fullscreen-leave'));
    win.on('resize', () => layout.relayout());
    win.on('focus', () => {
      if (isWindows) win.flashFrame(false);
      const id = layout.activeWorkspaceId;
      if (id) orchestrator.activate(id);
    });
    win.on('close', (e) => {
      if (sw === mainWindow()) {
        // Closing the main window quits the app; closing it or quitting while Claude runs would stop it: ask first.
        if (!confirmQuit()) return e.preventDefault();
        quitting = true;
        // Every other window too (secondary shell windows, ChatGPT OAuth popups): none may keep the app alive.
        for (const other of BrowserWindow.getAllWindows()) if (other !== win && !other.isDestroyed()) other.destroy();
        win.once('closed', () => app.quit());
        return;
      }
      // A secondary window hands its tabs back to the main window; runtimes keep running.
      if (quitting) return;
      const main = mainWindow();
      for (const [id, owner] of windowOf) if (owner === sw) attachTab(id, main);
      afterTabsChanged(main);
    });
    const winId = win.id;
    win.on('closed', () => {
      // The main window stays registered (destroyed) so "the main window" is always defined until exit.
      if (sw !== mainWindow()) windows.delete(winId);
      for (const [id, owner] of windowOf) if (owner === sw) windowOf.delete(id);
      broadcast();
    });
    return sw;
  }

  const mainWindow = (): ShellWindow => windows.values().next().value!;
  const focusedWindow = (): ShellWindow => {
    const f = BrowserWindow.getFocusedWindow();
    return (f && windows.get(f.id)) || mainWindow();
  };
  const tabsIn = (sw: ShellWindow) => [...windowOf].filter(([, owner]) => owner === sw).map(([id]) => id);
  const sendCommand = (sw: ShellWindow, c: ShellCommand) => {
    if (!sw.win.isDestroyed()) sw.win.webContents.send(SHELL_CHANNELS.command, c);
  };
  const openSettings = (sw: ShellWindow, target: SettingsTarget) => {
    if (!sw.win.isDestroyed()) sw.win.webContents.send(SHELL_CHANNELS.openSettings, target);
  };

  /** Shows a tab's ChatGPT view in `sw` (taking it out of its current window) without selecting it. */
  function attachTab(id: string, sw: ShellWindow): void {
    const c = chats.get(id);
    if (!c) return;
    const from = windowOf.get(id);
    if (from) {
      from.layout.unregister(id);
      if (!from.win.isDestroyed()) from.win.contentView.removeChildView(c.view);
    }
    sw.win.contentView.addChildView(c.view);
    sw.layout.register(id, c.view);
    windowOf.set(id, sw);
  }

  const first = createShellWindow();

  let broadcastQueued = false;
  const broadcast = () => {
    if (broadcastQueued) return;
    broadcastQueued = true;
    setTimeout(() => {
      broadcastQueued = false;
      const full = shellState();
      for (const sw of windows.values()) {
        if (!sw.win.isDestroyed()) sw.win.webContents.send(SHELL_CHANNELS.state, windowState(sw, full));
      }
      updateBadge();
    }, 16);
  };

  // Toasts and terminal output go to the window that owns the Workspace (toasts without one: the focused window).
  const sendToast = (t: Omit<ToastMessage, 'id'>) => {
    const sw = (t.workspaceId && windowOf.get(t.workspaceId)) || focusedWindow();
    if (!sw.win.isDestroyed()) sw.win.webContents.send(SHELL_CHANNELS.toast, { ...t, id: randomUUID() });
  };

  const pty = new PtyService(
    panes,
    (shell, args, opts) => nodePty.spawn(shell, args, { name: 'xterm-256color', ...opts }),
    loginShellEnv,
    (id, state) => orchestrator.setTerminalState(id, state),
    // The right-hand terminal always runs the user's interactive Claude Code (their own settings and status line).
    (id, { fresh }) => {
      const env = loginShellEnv();
      const exe = resolveClaudeExecutable(env);
      if (!exe) return { error: 'Claude Code executable not found (install Claude Code or set SIDEKICK_CLAUDE_PATH)' };
      const model = store.workspace(id)?.model ?? null;
      // Validated again here: on Windows the value ends up on a verbatim cmd.exe command line.
      const effort = store.workspace(id)?.effort;
      const stored = fresh ? null : (store.workspace(id)?.claudeSessionId ?? null);
      // Only a real session id reaches the (Windows: cmd.exe) command line.
      const sessionId = isClaudeSessionId(stored) ? stored : null;
      let settings: string;
      try {
        settings = isWindows ? stopHooks.windowsSettingsFile() : hookSettings();
      } catch (err) {
        return { error: `Could not install the Claude hook: ${err instanceof Error ? err.message : String(err)}` };
      }
      // Session name = project name (what `/rename` would set); `%` and `"` are dropped for the Windows command line.
      const sessionName = (store.workspace(id)?.name ?? '').replace(/[%"\p{Cc}]/gu, '').trim();
      const launch = launchCommand(exe, ['--settings', settings, ...(sessionName ? ['--name', sessionName] : []), ...(model ? ['--model', model] : []), ...(isEffortChoice(effort) ? ['--effort', effort] : []), ...(sessionId ? ['--resume', sessionId] : [])]);
      return {
        file: launch.file,
        // node-pty takes a verbatim Windows command line as a single string.
        args: launch.verbatim ? launch.args.join(' ') : launch.args,
        env: { ...env, SIDEKICK_EVENTS_DIR: stopHooks.open(id) },
      };
    },
  );

  const orchestrator: WorkspaceOrchestrator = new WorkspaceOrchestrator({
    store,
    panes,
    runner: new InteractiveClaudeRunner(pty, stopHooks),
    git: new GitEvidence(),
    chatFor: (id) => chats.get(id)?.adapter ?? null,
    isForeground: (id) => {
      const sw = windowOf.get(id);
      return !!sw && sw.layout.activeWorkspaceId === id && !sw.win.isDestroyed() && sw.win.isFocused() && !sw.win.isMinimized();
    },
    notifyTaskFinished: (n) => notifyFinished(n),
    notifyFlow: (n) => notifyFinished({ ...n, taskId: '', background: true }),
    onChange: broadcast,
    iconFor: (id) => icons.dataUrl(id, store.workspace(id)?.iconFile),
    defaultModel: () => defaultModel,
    claudeBusy: (id) => stopHooks.isBusy(id),
    taskSettled: (id) => relaunches.settled(id),
  });

  panes.onEvent((e) => {
    const sw = windowOf.get(e.workspaceId);
    if (!sw || sw.win.isDestroyed()) return;
    sw.win.webContents.send(SHELL_CHANNELS.terminalData, { workspaceId: e.workspaceId, data: e.data });
  });

  function shellState(): ShellState {
    const workspaces = [...store.get().workspaces]
      .sort((a, b) => a.sidebarOrder - b.sidebarOrder)
      .map((w) => orchestrator.view(w.id))
      .filter((v) => v !== null);
    const projects: ProjectEntry[] = [...store.get().workspaces]
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || a.name.localeCompare(b.name))
      .map((w) => ({ id: w.id, name: w.name, projectPath: w.projectPath, open: isOpen(w) }));
    return { workspaces, projects, activeWorkspaceId: mainWindow().layout.activeWorkspaceId, debugMode };
  }

  /** What one window's renderer sees: its own tabs and active tab; the Projects list is shared. */
  const windowState = (sw: ShellWindow, full = shellState()): ShellState => stateForWindow(full, (id) => windowOf.get(id) === sw, sw.layout.activeWorkspaceId);

  function updateBadge(): void {
    const n = orchestrator.attentionCount();
    app.setBadgeCount(n);
  }

  function notifyFinished(n: TaskFinishedNotice): void {
    sendToast({ workspaceId: n.workspaceId, kind: n.kind, title: n.title, body: n.body });
    const owner = () => windowOf.get(n.workspaceId) ?? mainWindow();
    if (n.background && Notification.isSupported()) {
      const note = new Notification({ title: n.title, body: n.body, silent: false });
      note.on('click', () => {
        const { win } = owner();
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        selectWorkspace(n.workspaceId);
      });
      note.show();
    }
    const { win } = owner();
    if (!win.isDestroyed() && !win.isFocused()) {
      if (isWindows) win.flashFrame(true);
      else app.dock?.bounce('informational');
    }
    updateBadge();
  }

  // ---------- Workspace runtimes ----------

  function createRuntime(w: WorkspaceRecord, sw: ShellWindow): void {
    orchestrator.register(w.id);
    // The user's own Claude turns (typed in the terminal) also end the flow's Claude side.
    stopHooks.onStop(w.id, (e) => {
      responses.record(w.id, e);
      orchestrator.observeClaudeStop(w.id);
      relaunches.settled(w.id);
    });
    const view = createChatGptView(
      {
        onPermission: (e) => diag(`[${w.id.slice(0, 8)}] permission ${e.kind} ${e.permission} ${e.origin} -> ${e.allowed ? 'ALLOW' : 'DENY'} (${e.reason})`),
      },
      (e) => diag(`[${w.id.slice(0, 8)}] ${e.kind} ${e.url}`),
    );
    view.setBackgroundColor('#212121');
    const adapter = new ChatGPTAdapter(view.webContents);
    chats.set(w.id, { view, adapter });
    attachTab(w.id, sw);

    const trackUrl = (url: string) => {
      diag(`[${w.id.slice(0, 8)}] navigated ${redactUrl(url)}`);
      if (!isChatGptConversationUrl(url) || !store.workspace(w.id)) return;
      const stored = conversationUrlToStore(url);
      if (store.workspace(w.id)!.chatConversationUrl !== stored) store.updateWorkspace(w.id, { chatConversationUrl: stored });
    };
    view.webContents.on('did-navigate', (_e, url) => {
      trackUrl(url);
      void view.webContents.session.cookies.flushStore();
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => trackUrl(url));
    view.webContents.on('render-process-gone', (_e, d) => diag(`[${w.id.slice(0, 8)}] render-process-gone ${d.reason}`));
    // ChatGPT's beforeunload handler would otherwise veto closing the window / quitting the app.
    view.webContents.on('will-prevent-unload', (e) => e.preventDefault());

    const start = w.chatConversationUrl && isChatGptConversationUrl(w.chatConversationUrl) ? w.chatConversationUrl : CHATGPT_HOME_URL;
    void view.webContents.loadURL(start).catch((err: Error) => diag(`[${w.id.slice(0, 8)}] load error ${redactUrlsIn(err.message)}`));

    pty.start(w.id, w.projectPath);
  }

  function destroyRuntime(id: string): void {
    const c = chats.get(id);
    const sw = windowOf.get(id);
    chats.delete(id);
    windowOf.delete(id);
    sw?.layout.unregister(id);
    orchestrator.unregister(id);
    pty.stop(id);
    stopHooks.close(id);
    responses.forget(id);
    relaunches.forget(id);
    if (c) {
      if (sw && !sw.win.isDestroyed()) sw.win.contentView.removeChildView(c.view);
      c.view.webContents.close();
    }
  }

  function selectWorkspace(id: string): void {
    const w = store.workspace(id);
    const sw = windowOf.get(id);
    if (!w || !chats.has(id) || !sw) return;
    sw.layout.activate(id);
    orchestrator.activate(id);
    // Only the main window's tab is remembered: on the next launch every tab opens there.
    if (sw === mainWindow()) store.setActiveWorkspace(id);
    store.updateWorkspace(id, { lastOpenedAt: new Date().toISOString() });
    sw.win.setTitle(w.name);
    broadcast();
  }

  /** Opens (if needed) and shows a saved Workspace; a tab already open elsewhere is shown in its own window. */
  function openWorkspace(id: string, sw: ShellWindow): void {
    const w = store.workspace(id);
    if (!w) return;
    if (!chats.has(id)) {
      store.updateWorkspace(id, { open: true });
      createRuntime(w, sw);
    }
    selectWorkspace(id);
    const owner = windowOf.get(id);
    if (owner && owner !== sw) owner.win.focus();
  }

  /** Moves a tab (ChatGPT view only; PTY, Claude and orchestration are untouched) into another window. */
  function moveTab(id: string, to: ShellWindow): void {
    const from = windowOf.get(id);
    if (!from || from === to) return;
    attachTab(id, to);
    selectWorkspace(id);
    if (to.win.isVisible()) to.win.focus();
    afterTabsChanged(from);
  }

  function moveTabToNewWindow(id: string): void {
    const from = windowOf.get(id);
    if (!from) return;
    const b = from.win.getBounds();
    const sw = createShellWindow({ x: b.x + 30, y: b.y + 30, width: b.width, height: b.height });
    void loadShellRenderer(sw);
    moveTab(id, sw);
  }

  // ---------- Candidate observation (passive; never launches anything) ----------

  let tick = 0;
  const inFlight = new Set<string>();
  const poll = setInterval(() => {
    tick++;
    for (const [id, c] of chats) {
      const active = id === windowOf.get(id)?.layout.activeWorkspaceId;
      if (!active && tick % INACTIVE_EVERY !== 0) continue;
      if (inFlight.has(id) || c.view.webContents.isLoading()) continue;
      inFlight.add(id);
      void (async () => {
        try {
          orchestrator.observeCandidate(id, await c.adapter.getLatestClaudePromptBlock());
          await orchestrator.observeUserMessage(id);
          if (tick % LOGIN_CHECK_EVERY === 0) {
            const s = await c.adapter.getPageState();
            orchestrator.setChatLoggedIn(id, s.ok ? s.value.composerFound && !s.value.loggedOutMarkers : null);
          }
        } finally {
          inFlight.delete(id);
        }
      })();
    }
  }, POLL_MS);

  // ---------- IPC (trusted shell renderer only) ----------

  /** The shell window whose renderer (main frame, showing the bundled shell page) sent `e`; undefined for any other sender. */
  const fromShell = (e: IpcMainInvokeEvent | IpcMainEvent): ShellWindow | undefined => {
    const frame = e.senderFrame;
    if (!frame || !isShellPage(frame.url)) return undefined;
    for (const sw of windows.values()) if (!sw.win.isDestroyed() && e.sender === sw.win.webContents && frame === sw.win.webContents.mainFrame) return sw;
    return undefined;
  };
  /** Handlers that need the calling window get it as their first argument. */
  const handleIn = (channel: string, fn: (sw: ShellWindow, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (e, ...args) => {
      const sw = fromShell(e);
      if (!sw) throw new Error('unauthorized sender');
      return fn(sw, ...args);
    });
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => handleIn(channel, (_sw, ...args) => fn(...args));
  const onIn = (channel: string, fn: (sw: ShellWindow, arg: unknown) => void) =>
    ipcMain.on(channel, (e, arg) => {
      const sw = fromShell(e);
      if (sw) fn(sw, arg);
    });
  const on = (channel: string, fn: (arg: unknown) => void) => onIn(channel, (_sw, arg) => fn(arg));
  const known = (id: unknown): id is string => isId(id) && chats.has(id);

  handleIn('shell:get-state', (sw) => windowState(sw));
  handle('shell:terminal-snapshot', (id) => (known(id) ? panes.snapshot(id) : ''));
  handleIn('shell:set-overlay', (sw, hidden) => sw.layout.setSuppressed(hidden === true));

  handle('workspace:select', (id) => {
    if (known(id)) selectWorkspace(id);
  });
  // A window reorders only its own tabs; tabs of other windows keep their slots in the global order.
  handleIn('workspace:reorder', (sw, ids) => {
    if (!Array.isArray(ids) || !ids.every(isId)) return { ok: false };
    const globalOrder = [...store.get().workspaces].filter(isOpen).sort((a, b) => a.sidebarOrder - b.sidebarOrder).map((w) => w.id);
    const merged = mergeWindowOrder(globalOrder, (id) => windowOf.get(id) === sw, ids);
    if (!merged || !store.reorderWorkspaces(merged)) return { ok: false };
    broadcast();
    return { ok: true };
  });
  const chooseIcon = async (sw: ShellWindow, id: string): Promise<{ ok: true } | { ok: false; code?: string; detail: string }> => {
    const r = await dialog.showOpenDialog(sw.win, { title: 'Choose an icon for this Workspace', properties: ['openFile'], filters: [{ name: 'Images', extensions: ICON_EXTENSIONS }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, code: 'cancelled', detail: '' };
    if (!store.workspace(id)) return { ok: false, detail: 'Project not found.' };
    const res = icons.importFrom(id, r.filePaths[0]);
    if (!res.ok) return { ok: false, detail: res.detail };
    store.updateWorkspace(id, { iconFile: res.file });
    broadcast();
    return { ok: true };
  };
  const removeIcon = (id: string) => {
    icons.remove(id, store.workspace(id)?.iconFile);
    store.updateWorkspace(id, { iconFile: null });
  };
  // Right-click on a tab: native context menu for that Workspace.
  handleIn('workspace:context-menu', (sw, id) => {
    if (!known(id)) return;
    const w = store.workspace(id)!;
    const owner = windowOf.get(id);
    const moves: MenuItemConstructorOptions[] = [
      // A window's only tab would just leave an empty window behind.
      ...(owner && tabsIn(owner).length > 1 ? [{ label: 'Move to New Window', click: () => moveTabToNewWindow(id) }] : []),
      ...(owner && owner !== mainWindow() ? [{ label: 'Move to Main Window', click: () => moveTab(id, mainWindow()) }] : []),
    ];
    Menu.buildFromTemplate([
      ...(moves.length ? [...moves, { type: 'separator' } as const] : []),
      {
        label: 'Change Icon…',
        click: () =>
          void chooseIcon(sw, id).then((r) => {
            if (!r.ok && r.code !== 'cancelled') sendToast({ workspaceId: id, kind: 'error', title: 'Icon not changed', body: r.detail });
          }),
      },
      {
        label: 'Use Initial Instead',
        enabled: !!w.iconFile,
        click: () => {
          removeIcon(id);
          broadcast();
        },
      },
      { type: 'separator' },
      {
        label: 'Settings…',
        click: () => {
          selectWorkspace(id);
          openSettings(windowOf.get(id) ?? sw, { kind: 'project', workspaceId: id });
        },
      },
    ]).popup({ window: sw.win });
  });
  handleIn('workspace:pick-folder', async (sw) => {
    const r = await dialog.showOpenDialog(sw.win, { title: 'Choose project folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : { path: r.filePaths[0], name: basename(r.filePaths[0]) };
  });
  handleIn('workspace:create', (sw, arg) => {
    const { name, projectPath } = (arg ?? {}) as { name?: unknown; projectPath?: unknown };
    const n = validateWorkspaceName(name);
    if (!n) return { ok: false, detail: 'Project name is required (max 60 characters).' };
    if (typeof projectPath !== 'string' || !isAbsolute(projectPath) || !existsSync(projectPath) || !statSync(projectPath).isDirectory())
      return { ok: false, detail: 'Choose an existing local folder.' };
    const all = store.get().workspaces;
    const now = new Date().toISOString();
    const record: WorkspaceRecord = {
      id: randomUUID(),
      name: n,
      projectPath,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      sidebarColor: colorForName(n, all.map((w) => w.sidebarColor)),
      sidebarOrder: all.reduce((m, w) => Math.max(m, w.sidebarOrder), -1) + 1,
      chatConversationUrl: null,
      claudeSessionId: null,
      uiState: { splitRatio: DEFAULT_SPLIT_RATIO },
      lastTaskId: null,
    };
    store.addWorkspace(record);
    createRuntime(record, sw);
    selectWorkspace(record.id);
    return { ok: true, id: record.id };
  });
  // A window whose tabs changed shows its current or first remaining tab; the main window falls back to its
  // start page, an emptied secondary window closes.
  function afterTabsChanged(sw: ShellWindow | undefined): void {
    if (!sw || sw.win.isDestroyed()) return broadcast();
    const ordered = [...store.get().workspaces].sort((a, b) => a.sidebarOrder - b.sidebarOrder).map((w) => w.id);
    const next = nextActiveTab(ordered, (id) => windowOf.get(id) === sw, sw.layout.activeWorkspaceId);
    if (next) selectWorkspace(next);
    else if (sw !== mainWindow()) sw.win.close();
    else {
      store.setActiveWorkspace(null);
      sw.win.setTitle('Avva Mobile Sidekick');
    }
    broadcast();
  }
  const removeWorkspace = (id: string) => {
    const sw = windowOf.get(id);
    icons.remove(id, store.workspace(id)?.iconFile);
    destroyRuntime(id);
    store.removeWorkspace(id);
    afterTabsChanged(sw ?? mainWindow());
  };
  /** The existing delete confirmation (refused while Claude works in the project). */
  const confirmAndRemove = (sw: ShellWindow, id: string): { ok: true } | { ok: false; code?: string; detail?: string } => {
    const w = store.workspace(id);
    if (!w) return { ok: false, detail: 'Project not found.' };
    if (orchestrator.activeTaskWorkspaceIds().includes(id)) return { ok: false, detail: 'Claude is still working in this project. Wait for it to finish or cancel the task first.' };
    const choice = dialog.showMessageBoxSync(sw.win, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete “${w.name}”?`,
      detail: 'The project and its ChatGPT/Claude record are removed from the app. Files on disk are not touched.',
    });
    if (choice !== 1) return { ok: false, code: 'cancelled' };
    if (!store.workspace(id)) return { ok: false, detail: 'Project not found.' };
    if (orchestrator.activeTaskWorkspaceIds().includes(id)) return { ok: false, detail: 'Claude is still working in this project. Wait for it to finish or cancel the task first.' };
    removeWorkspace(id);
    return { ok: true };
  };
  // Asks for confirmation first (same dialog as the Projects page's Delete).
  handleIn('workspace:remove', (sw, id) => {
    if (!isId(id) || !store.workspace(id)) return { ok: false, detail: 'Project not found.' };
    return confirmAndRemove(sw, id);
  });
  // Closing a tab frees its ChatGPT view and terminal; the saved Workspace (conversation, Claude session) stays.
  handle('workspace:close', (id) => {
    if (!known(id)) return { ok: false };
    if (orchestrator.activeTaskWorkspaceIds().includes(id)) return { ok: false, detail: 'Claude is still working in this project. Wait for it to finish or cancel the task, then close the tab.' };
    const sw = windowOf.get(id);
    destroyRuntime(id);
    store.updateWorkspace(id, { open: false });
    afterTabsChanged(sw);
    return { ok: true };
  });
  // Model shortcut: relaunch the terminal's Claude Code with --model, resuming the same session.
  const taskActive = (id: string) => orchestrator.activeTaskWorkspaceIds().includes(id);
  const relaunches = new DeferredRelaunch({
    working: (id) => !known(id) || taskActive(id) || stopHooks.isBusy(id),
    isRunning: (id) => pty.isRunning(id),
    relaunch: (id, why) => {
      panes.writeOutput(id, 'pty', `\r\n\x1b[2m[Switching to ${why}…]\x1b[0m\r\n`);
      pty.relaunch(id);
    },
  });
  /** Stores the model choice (null = app default) and relaunches the terminal's Claude Code if the effective model changed. */
  const applyModel = (id: string, model: ModelChoice | null, relaunch = true): { ok: true } | { ok: false; detail: string } => {
    const w = store.workspace(id);
    if (!w) return { ok: false, detail: 'Project not found.' };
    const before = w.model ?? defaultModel;
    const after = model ?? defaultModel;
    if ((w.model ?? null) === model) return { ok: true };
    store.updateWorkspace(id, { model });
    if (relaunch && before !== after && pty.isRunning(id)) relaunches.request(id, after ?? 'the default model');
    broadcast();
    return { ok: true };
  };
  handle('workspace:set-model', (id, model) => {
    if (!known(id) || !isModelChoice(model)) return { ok: false };
    // The shortcut picks a model explicitly; picking the current effective model changes nothing.
    if ((store.workspace(id)!.model ?? defaultModel) === model) return { ok: true };
    return applyModel(id, model);
  });
  // Effort shortcut (null = Claude Code's default): relaunch with --effort, resuming the same session.
  handle('workspace:set-effort', (id, effort) => {
    if (!known(id) || (effort !== null && !isEffortChoice(effort))) return { ok: false };
    if ((store.workspace(id)!.effort ?? null) === effort) return { ok: true };
    store.updateWorkspace(id, { effort });
    if (pty.isRunning(id)) relaunches.request(id, `${effort ?? 'the default'} effort`);
    broadcast();
    return { ok: true };
  });

  // ---------- Project Settings (tab right-click → Settings…) ----------

  const projectSettings = (id: string): ProjectSettings | null => {
    const w = store.workspace(id);
    if (!w) return null;
    return {
      id: w.id,
      name: w.name,
      projectPath: w.projectPath,
      color: w.sidebarColor,
      iconUrl: icons.dataUrl(w.id, w.iconFile),
      initial: initialFor(w.name),
      model: w.model ?? null,
      defaultModel,
      chatConversationUrl: w.chatConversationUrl,
      claudeSessionId: w.claudeSessionId,
      githubRepository: w.githubRepository ?? null,
      githubAccess: w.githubAccess ?? { status: 'unchecked' },
      taskActive: taskActive(id),
    };
  };
  const isDirectory = (p: string) => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  handle('workspace:get-settings', async (id) => {
    if (!isId(id)) return null;
    // Best-effort prefill from the folder's git remote while the repository was never set.
    if (await prefillGithubRepository(store, id)) broadcast();
    return projectSettings(id);
  });
  handleIn('workspace:choose-icon', (sw, id) => (isId(id) && store.workspace(id) ? chooseIcon(sw, id) : { ok: false, detail: 'Project not found.' }));
  // One validated entry point for every per-project setting; side effects follow the change.
  handleIn('workspace:update-settings', async (sw, id, raw) => {
    if (!isId(id) || !store.workspace(id)) return { ok: false, detail: 'Project not found.' };
    const v = validateProjectSettingsPatch(raw, isDirectory);
    if (!v.ok) return { ok: false, code: 'invalid', detail: v.detail };
    const patch = v.patch;
    const w = store.workspace(id)!;
    const pathChanged = patch.projectPath !== undefined && patch.projectPath !== w.projectPath;
    if (pathChanged) {
      if (taskActive(id)) return { ok: false, detail: 'Claude is running a task in this project. Change the folder after it finishes.' };
      const { response } = await dialog.showMessageBox(sw.win, {
        type: 'question',
        buttons: ['Cancel', 'Change Folder'],
        defaultId: 1,
        cancelId: 0,
        message: `Use “${basename(patch.projectPath!)}” as the project folder?`,
        detail: `${patch.projectPath}\n\nThe terminal restarts in the new folder and a new Claude session starts. The old session is not resumed.`,
      });
      if (response !== 1) return { ok: false, code: 'cancelled' };
      if (!store.workspace(id)) return { ok: false, detail: 'Project not found.' };
      if (taskActive(id)) return { ok: false, detail: 'Claude is running a task in this project. Change the folder after it finishes.' };
    }
    if (patch.model !== undefined) {
      // A folder change restarts Claude anyway (with the new model): no separate relaunch.
      const r = applyModel(id, patch.model, !pathChanged);
      if (!r.ok) return r;
    }
    if (patch.name !== undefined && patch.name !== w.name) {
      store.updateWorkspace(id, { name: patch.name });
      const owner = windowOf.get(id);
      if (owner && owner.layout.activeWorkspaceId === id && !owner.win.isDestroyed()) owner.win.setTitle(patch.name);
    }
    if (patch.color !== undefined) store.updateWorkspace(id, { sidebarColor: patch.color });
    if (patch.icon === null) removeIcon(id);
    if (patch.chatConversationUrl !== undefined) {
      store.updateWorkspace(id, { chatConversationUrl: patch.chatConversationUrl });
      const c = chats.get(id);
      const url = patch.chatConversationUrl ?? CHATGPT_HOME_URL;
      if (c) void c.view.webContents.loadURL(url).catch((err: Error) => diag(`[${id.slice(0, 8)}] load error ${redactUrlsIn(err.message)}`));
    }
    if (patch.githubRepository !== undefined && patch.githubRepository !== (w.githubRepository ?? null)) {
      setGithubRepository(store, id, patch.githubRepository);
    }
    if (pathChanged) {
      store.updateWorkspace(id, { projectPath: patch.projectPath! });
      orchestrator.resetSession(id);
      if (chats.has(id)) {
        panes.writeOutput(id, 'pty', `\r\n\x1b[2m[Project folder changed: restarting in ${patch.projectPath}…]\x1b[0m\r\n`);
        pty.restartIn(id, patch.projectPath!);
      }
    }
    broadcast();
    return { ok: true, settings: projectSettings(id) };
  });
  // Explicit "Verify access": always re-checks through the GitHub API; the saved result is only a hint.
  handle('workspace:verify-github', async (id) => {
    if (!isId(id) || !store.workspace(id)) return { ok: false, detail: 'Project not found.' };
    if (!store.workspace(id)!.githubRepository) return { ok: false, detail: 'Enter a GitHub repository first.' };
    await verifyWorkspaceGithub(store, id, { getToken: () => defaultGithubToken(), fetch, now: () => new Date() });
    broadcast();
    return { ok: true, settings: projectSettings(id) };
  });
  handleIn('workspace:open', (sw, id) => {
    if (!isId(id) || !store.workspace(id)) return { ok: false };
    openWorkspace(id, sw);
    return { ok: true };
  });
  // Right-click on a project in the Projects start page.
  handleIn('project:context-menu', (sw, id) => {
    if (!isId(id)) return;
    const w = store.workspace(id);
    if (!w) return;
    Menu.buildFromTemplate([
      {
        label: 'Open',
        click: () => {
          openWorkspace(id, sw);
          // Tell the renderer to leave the start page.
          if (windowOf.get(id) === sw) sendCommand(sw, 'projects-opened');
        },
      },
      {
        label: 'Delete',
        click: () => {
          const r = confirmAndRemove(sw, id);
          if (!r.ok && r.detail) void dialog.showMessageBox(sw.win, { type: 'info', message: 'Project not deleted', detail: r.detail });
        },
      },
    ]).popup({ window: sw.win });
  });
  handle('handoff:send', async (id) => (known(id) ? orchestrator.sendToClaude(id, 'button') : { ok: false, code: 'unknown_workspace', detail: '' }));
  handle('handoff:cancel-auto', (id) => (known(id) ? orchestrator.cancelAutoSendRequest(id) : { ok: false }));
  handle('task:cancel', (id) => (known(id) ? orchestrator.cancelTask(id) : { ok: false }));
  handle('session:reset', (id) => (known(id) ? orchestrator.resetSession(id) : { ok: false }));
  // Copy of Claude's last response: clipboard only, never touches the PTY, the session or a running task.
  handle('response:info', (id) => (known(id) ? responses.info(id) : { available: false, blocks: [] }));
  handle('response:copy', (id, target) => {
    const t = target === 'auto' || target === 'full' ? target : isCopyBlock(target) ? { block: target.block } : null;
    return known(id) && t ? responses.copy(id, t) : { ok: false, code: 'invalid', detail: '' };
  });
  handle('review:send', (id, taskId) => (known(id) && isId(taskId) ? orchestrator.sendReview(id, taskId) : { ok: false, code: 'invalid', detail: '' }));
  handle('terminal:restart', (id) => {
    if (known(id)) pty.restart(id);
  });

  on('terminal:input', (arg) => {
    const { workspaceId, data } = (arg ?? {}) as { workspaceId?: unknown; data?: unknown };
    if (!known(workspaceId) || typeof data !== 'string' || data.length > 65_536) return;
    // Escape / Ctrl+C interrupt Claude's turn, which then ends without a Stop event.
    if (data === '\x1b' || data === '\x03') stopHooks.interrupt(workspaceId);
    panes.writeUserInput(workspaceId, data);
  });
  on('terminal:resize', (arg) => {
    const { workspaceId, cols, rows } = (arg ?? {}) as { workspaceId?: unknown; cols?: unknown; rows?: unknown };
    if (known(workspaceId) && Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) > 1 && (rows as number) > 1 && (cols as number) < 1000 && (rows as number) < 500)
      pty.resize(workspaceId, cols as number, rows as number);
  });

  // Fire-and-forget so dragging stays smooth: only setBounds on the existing view (D023).
  onIn('layout:set-split', (sw, arg) => {
    const { workspaceId, ratio, commit } = (arg ?? {}) as { workspaceId?: unknown; ratio?: unknown; commit?: unknown };
    if (!known(workspaceId) || workspaceId !== sw.layout.activeWorkspaceId || !isValidSplitRatio(ratio)) return;
    if (commit === true) {
      sw.layout.commit(ratio);
      broadcast();
    } else sw.layout.preview(ratio);
  });

  // View buttons (ChatGPT Focus / Split / Claude Focus): act on the sending window's active Workspace; persisted per Workspace.
  onIn('layout:set-view', (sw, arg) => {
    const { workspaceId, mode } = (arg ?? {}) as { workspaceId?: unknown; mode?: unknown };
    if (!known(workspaceId) || workspaceId !== sw.layout.activeWorkspaceId || !isViewMode(mode)) return;
    sw.layout.setViewMode(mode);
    broadcast();
  });

  // Developer-only adapter diagnostics (D025): refused unless Developer → Diagnostics is enabled.
  const diagHandle = (channel: string, fn: (c: ChatRuntime, arg: unknown) => unknown) =>
    handleIn(channel, (sw, arg) => {
      const id = sw.layout.activeWorkspaceId;
      const c = id ? chats.get(id) : undefined;
      if (!debugMode) return { ok: false, code: 'debug_disabled' };
      if (!c) return { ok: false, code: 'no_workspace' };
      return fn(c, arg);
    });
  diagHandle('diag:state', (c) => c.adapter.getPageState());
  diagHandle('diag:capture', (c) => c.adapter.getLatestClaudePromptBlock());
  diagHandle('diag:latest-user', (c) => c.adapter.getLatestUserMessage());
  diagHandle('diag:mic-status', () => ({ microphone: systemPreferences.getMediaAccessStatus('microphone') }));
  diagHandle('diag:home', (c) => c.view.webContents.loadURL(CHATGPT_HOME_URL).then(() => ({ ok: true })));
  diagHandle('diag:insert', (c, arg) =>
    typeof arg === 'string' && arg.length > 0 && arg.length <= MAX_PROMPT_CHARS ? c.adapter.insertComposerText(arg) : { ok: false, code: 'invalid_input' },
  );
  diagHandle('diag:submit', (c) => c.adapter.submitComposer());

  // ---------- App Settings (app menu → Settings…) ----------

  const appSettings = (): AppSettings => ({
    autoSendOnRequest: orchestrator.autoSendEnabled(),
    developerMode: debugMode,
    claudePromptSuffix: orchestrator.claudePromptSuffix(),
    defaultModel,
    version: app.getVersion(),
    userDataPath: userData,
  });
  // Both are mirrored by menu checkboxes; every window gets the change through the state push.
  const setAutoSend = (on: boolean) => {
    orchestrator.setAutoSendEnabled(on);
    buildMenu();
    broadcast();
  };
  const setDebugMode = (on: boolean) => {
    debugMode = on;
    buildMenu();
    broadcast();
  };
  handle('app:get-settings', () => appSettings());
  handle('app:update-settings', (raw) => {
    const v = validateAppSettingsPatch(raw);
    if (!v.ok) return { ok: false, code: 'invalid', detail: v.detail };
    if (v.patch.autoSendOnRequest !== undefined) setAutoSend(v.patch.autoSendOnRequest);
    if (v.patch.developerMode !== undefined) setDebugMode(v.patch.developerMode);
    if (v.patch.claudePromptSuffix !== undefined) orchestrator.setClaudePromptSuffix(v.patch.claudePromptSuffix);
    return { ok: true, settings: appSettings() };
  });
  handle('app:reveal-user-data', () => shell.showItemInFolder(join(userData, 'workspace-state.json')));
  handle('app:open-coffee', () => shell.openExternal(BUY_ME_A_COFFEE_URL));

  // First-launch requirements popup (D037).
  const micStatus = () => microphoneStatus(process.platform, () => systemPreferences.getMediaAccessStatus('microphone'));
  handle('app:check-setup', async (): Promise<SetupCheck> => {
    const env = loginShellEnv();
    const [claude, git] = await Promise.all([checkTool(resolveClaudeExecutable(env), env), checkTool('git', env)]);
    return { claude, git, microphone: micStatus() };
  });
  handle('app:open-setup-link', (key) => (isSetupLink(key) ? shell.openExternal(SETUP_LINKS[key]) : undefined));
  // Asks once (macOS); after a denial only System Settings can grant it, so open that page instead.
  handle('app:request-microphone', async () => {
    const status = micStatus();
    if (isMac && status === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
    else if (status !== 'granted' && status !== 'not-needed') {
      const url = microphoneSettingsUrl(process.platform);
      if (url) await shell.openExternal(url);
    }
    return micStatus();
  });

  // ---------- Menu ----------

  // Menu commands go to the focused shell window.
  const command = (c: ShellCommand) => sendCommand(focusedWindow(), c);
  const settingsItem: MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings(focusedWindow(), { kind: 'app' }) };
  const updates = new UpdateService({
    updater: autoUpdater,
    enabled: app.isPackaged && !process.env.SIDEKICK_NO_UPDATES,
    currentVersion: app.getVersion(),
    showMessage: async (options) => (await dialog.showMessageBox(focusedWindow().win, options)).response,
    // Only the version: error messages can carry download URLs.
    log: (event, data) => diag(`${event}${typeof data?.version === 'string' ? ` ${data.version}` : ''}`),
    canQuit: () => confirmQuit(),
  });
  const updatesItem: MenuItemConstructorOptions = { label: 'Check for Updates…', click: () => void updates.check() };
  const buildMenu = () => {
    const template: MenuItemConstructorOptions[] = [
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                updatesItem,
                { type: 'separator' },
                settingsItem,
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Workspace…', accelerator: 'CmdOrCtrl+N', click: () => command('new-workspace') },
          // macOS has Settings in the app menu.
          ...(isMac ? [] : [{ type: 'separator' } as const, settingsItem]),
          { type: 'separator' },
          { role: 'close' },
          // macOS has these in the app menu.
          ...(isMac ? [] : [{ type: 'separator' } as const, { role: 'about' } as const, { role: 'quit' } as const]),
        ],
      },
      { role: 'editMenu' },
      {
        label: 'Workspace',
        submenu: [
          { label: 'Send to Claude…', accelerator: 'CmdOrCtrl+Shift+Enter', click: () => command('send-to-claude') },
          { type: 'separator' },
          {
            // D034: when the user's own ChatGPT message asks for it, the ready prompt is sent after a cancellable countdown.
            label: 'Auto-send when I ask ChatGPT',
            type: 'checkbox',
            checked: orchestrator.autoSendEnabled(),
            click: (item) => setAutoSend(item.checked),
          },
        ],
      },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
      {
        label: 'Developer',
        submenu: [
          {
            label: 'Diagnostics',
            type: 'checkbox',
            checked: debugMode,
            click: (item) => setDebugMode(item.checked),
          },
          { label: 'Shell DevTools', click: () => focusedWindow().win.webContents.openDevTools({ mode: 'detach' }) },
          {
            label: 'ChatGPT DevTools (active Workspace)',
            click: () => {
              const id = focusedWindow().layout.activeWorkspaceId;
              if (id) chats.get(id)?.view.webContents.openDevTools({ mode: 'detach' });
            },
          },
          { label: 'Reveal Diagnostics Log', click: () => void import('electron').then(({ shell }) => shell.showItemInFolder(diag.file)) },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          ...(isMac ? [] : [updatesItem, { type: 'separator' } as MenuItemConstructorOptions]),
          { label: 'Setup Checklist…', click: () => command('setup-prompt') },
          { label: 'Buy Me a Coffee…', click: () => void shell.openExternal(BUY_ME_A_COFFEE_URL) },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };
  buildMenu();

  // ---------- Lifecycle ----------

  // Closing the main window or quitting while Claude runs would stop it: ask first.
  let quitConfirmed = false;
  const confirmQuit = (): boolean => {
    if (quitConfirmed) return true;
    const names = orchestrator.activeTaskWorkspaceIds().map((id) => store.workspace(id)?.name ?? id);
    if (names.length === 0) return true;
    const choice = dialog.showMessageBoxSync(focusedWindow().win, {
      type: 'warning',
      buttons: ['Keep Running', 'Quit and Stop Claude'],
      defaultId: 0,
      cancelId: 0,
      message: 'Claude is still working',
      detail: `Quitting stops the running Claude task in: ${names.join(', ')}.`,
    });
    quitConfirmed = choice === 1;
    return quitConfirmed;
  };
  let quitStartedAt = 0;
  app.on('before-quit', (e) => {
    if (!first.win.isDestroyed() && !confirmQuit()) {
      e.preventDefault();
      return;
    }
    if (!quitStartedAt) {
      quitStartedAt = Date.now();
      diag('lifecycle before-quit');
    }
    // Secondary windows close without handing their tabs back; nothing about windows is persisted.
    quitting = true;
    clearInterval(poll);
    updates.stop();
    orchestrator.shutdown();
    pty.stopAll();
    stopHooks.closeAll();
    store.flush();
    // Persist the ChatGPT login even if the process is terminated soon after quitting.
    void session.fromPartition(CHATGPT_PARTITION).cookies.flushStore();
    // ChatGPT pages are closed right away instead of waiting for their windows to tear down.
    for (const c of chats.values()) if (!c.view.webContents.isDestroyed()) c.view.webContents.close();
  });
  app.on('will-quit', () => diag(`lifecycle will-quit${quitStartedAt ? ` +${Date.now() - quitStartedAt}ms` : ''}`));

  await loadShellRenderer(first);

  const openRecords = store.get().workspaces.filter(isOpen);
  for (const w of openRecords) createRuntime(w, first);
  const initial = store.get().activeWorkspaceId ?? openRecords[0]?.id;
  if (initial) selectWorkspace(initial);
  broadcast();

  // First launch: the requirements popup (D037). The coffee popup waits for the next launch; each is shown once ever.
  const prefs = store.preferences();
  const firstLaunchPopup: ShellCommand | null = !prefs.setupPromptShown ? 'setup-prompt' : !prefs.coffeePromptShown ? 'coffee-prompt' : null;
  if (firstLaunchPopup) {
    store.setPreferences(firstLaunchPopup === 'setup-prompt' ? { setupPromptShown: true } : { coffeePromptShown: true });
    setTimeout(() => sendCommand(first, firstLaunchPopup), 1500);
  }

  updates.start();

  return {
    focusMainWindow: () => {
      const { win } = first;
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
  };
}
