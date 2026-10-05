import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ratioFromPointer } from '../../domain/layout/splitPane';
import { computeViewGeometry } from '../../domain/layout/viewMode';
import { workAreaFor } from '../../shared/shellLayout';
import type { SettingsTarget } from '../../shared/settings';
import type { ShellState, ToastMessage } from '../../shared/state';
import type { WorkspaceApi } from './api';
import { ClaudeStatusBar } from './components/ClaudeStatusBar';
import { DevPane, type DevPaneActions } from './components/DevPane';
import { AppSettings } from './components/AppSettings';
import { CoffeeDialog } from './components/CoffeeDialog';
import { NewWorkspaceDialog } from './components/NewWorkspaceDialog';
import { SetupDialog } from './components/SetupDialog';
import { ProjectSettings } from './components/ProjectSettings';
import { StartPage } from './components/StartPage';
import { TabBar } from './components/TabBar';
import { disposeTerminal, terminalData } from './terminals';

const EMPTY: ShellState = { workspaces: [], projects: [], activeWorkspaceId: null, debugMode: false };

function useWindowSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

export function App({ api }: { api: WorkspaceApi }) {
  const [state, setState] = useState<ShellState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<null | 'new' | 'coffee' | 'setup'>(null);
  // First-launch popups arrive together (coffee, then requirements); later ones wait for the open one.
  const queuedDialogs = useRef<Array<'coffee' | 'setup'>>([]);
  const queueDialog = useCallback((d: 'coffee' | 'setup') => {
    setDialog((cur) => {
      if (cur === null) return d;
      if (cur !== d && !queuedDialogs.current.includes(d)) queuedDialogs.current.push(d);
      return cur;
    });
  }, []);
  const closeDialog = useCallback(() => setDialog(queuedDialogs.current.shift() ?? null), []);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [settings, setSettings] = useState<SettingsTarget | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const knownIds = useRef(new Set<string>());
  const size = useWindowSize();

  // The Projects start page shows on request and whenever no project tab is open.
  const startVisible = showStart || state.workspaces.length === 0;
  // A settings screen replaces the panes (like the start page) until it is closed.
  const active = startVisible || settings ? null : (state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null);
  const chatgptLoggedIn = state.workspaces.some((w) => w.chatgpt.loggedIn === true)
    ? true
    : state.workspaces.some((w) => w.chatgpt.loggedIn === false)
      ? false
      : null;
  const closeSettings = useCallback(() => setSettings(null), []);

  const toast = useCallback((t: Omit<ToastMessage, 'id'>) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === 'error' ? 12_000 : t.kind === 'success' && !t.body ? 2_500 : 8_000);
  }, []);

  useEffect(() => {
    const offs = [
      api.onState((s) => setState(s)),
      api.onTerminalData(({ workspaceId, data }) => terminalData(workspaceId, data)),
      api.onToast((t) => toast(t)),
      api.onOpenSettings((t) => {
        setDialog(null);
        setSettings(t);
      }),
    ];
    void api.getState().then((s) => {
      setState(s);
      setLoaded(true);
    });
    return () => offs.forEach((o) => o());
  }, [api, toast]);

  // Drop renderer state of removed Workspaces.
  useEffect(() => {
    const ids = new Set(state.workspaces.map((w) => w.id));
    for (const id of knownIds.current) if (!ids.has(id)) disposeTerminal(id);
    knownIds.current = ids;
    // Project Settings of a tab that was closed or deleted (or moved to another window) closes.
    setSettings((cur) => (cur?.kind === 'project' && !ids.has(cur.workspaceId) ? null : cur));
  }, [state.workspaces, api]);

  // Native ChatGPT views sit above the DOM; hide the active one while a full-window dialog is open.
  useEffect(() => {
    void api.setOverlay(dialog !== null || startVisible || settings !== null);
  }, [dialog, startVisible, settings, api]);

  // The main process switched tabs (notification click, project opened): leave the start page.
  useEffect(() => setShowStart(false), [state.activeWorkspaceId]);

  const openNew = useCallback(() => setDialog('new'), []);
  const selectTab = useCallback(
    (id: string) => {
      setShowStart(false);
      setSettings(null);
      void api.selectWorkspace(id);
    },
    [api],
  );

  const actions: DevPaneActions = useMemo(
    () => ({
      sendToClaude: async (id) => {
        setBusy(true);
        try {
          const r = await api.sendToClaude(id);
          if (!r.ok) toast({ workspaceId: id, kind: 'error', title: 'Claude not started', body: r.detail ?? 'No Claude Prompt block found' });
        } finally {
          setBusy(false);
        }
      },
      cancelAutoSend: (id) => void api.cancelAutoSend(id),
      cancelTask: (id) => void api.cancelTask(id),
      resetSession: (id) =>
        void api.resetSession(id).then((r) => {
          if (!r.ok) toast({ workspaceId: id, kind: 'error', title: 'Session not reset', body: r.detail ?? '' });
        }),
      retryReview: (id, taskId) =>
        void api.retryReview(id, taskId).then((r) => {
          if (!r.ok) toast({ workspaceId: id, kind: 'error', title: 'Result not delivered', body: r.detail ?? '' });
        }),
      restartTerminal: (id) => void api.terminalRestart(id),
      clearTerminal: (id) => api.terminalInput(id, '/clear\r'),
      responseInfo: (id) => api.responseInfo(id),
      copyResponse: async (id, target) => {
        const r = await api.copyResponse(id, target);
        if (r.ok) toast({ workspaceId: id, kind: 'success', title: r.kind === 'code' ? 'Code copied' : 'Response copied', body: '' });
        else if (r.code !== 'choose') toast({ workspaceId: id, kind: 'error', title: 'Nothing copied', body: ('detail' in r && r.detail) || 'Copy failed.' });
        return r.ok ? { ok: true } : r.code === 'choose' && 'blocks' in r ? { ok: false, blocks: r.blocks } : { ok: false };
      },
      setModel: (id, model) =>
        void api.setModel(id, model).then((r) => {
          if (!r.ok) toast({ workspaceId: id, kind: 'error', title: 'Model not changed', body: r.detail ?? '' });
        }),
      setEffort: (id, effort) =>
        void api.setEffort(id, effort).then((r) => {
          if (!r.ok) toast({ workspaceId: id, kind: 'error', title: 'Effort not changed', body: r.detail ?? '' });
        }),
    }),
    [api, toast],
  );

  useEffect(
    () =>
      api.onCommand((c) => {
        if (c === 'new-workspace') {
          setSettings(null);
          setShowStart(true);
        }
        if (c === 'projects-opened') {
          setSettings(null);
          setShowStart(false);
        }
        if (c === 'coffee-prompt') queueDialog('coffee');
        if (c === 'setup-prompt') queueDialog('setup');
        if (c === 'fullscreen-enter') setFullscreen(true);
        if (c === 'fullscreen-leave') setFullscreen(false);
        if (c === 'send-to-claude' && active) void actions.sendToClaude(active.id);
      }),
    [api, active, actions, queueDialog],
  );

  // ---------- Split geometry (shared with main, D023) ----------
  const area = workAreaFor(size.w, size.h);
  const ratio = dragRatio ?? active?.splitRatio ?? 0.6;
  // Dragging the divider turns the layout custom immediately (main persists it on release).
  const viewMode = active?.viewMode ?? 'split';
  const view = computeViewGeometry(area, viewMode, ratio);
  const devFrame = view.devPane;
  const dragging = useRef(false);
  const frame = useRef(0);
  const latest = useRef(ratio);

  useEffect(() => setDragRatio(null), [active?.id]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !active) return;
    e.preventDefault();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('resizing');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !active) return;
    const r = ratioFromPointer(e.clientX - area.x, area.width);
    latest.current = r;
    setDragRatio(r);
    if (!frame.current) {
      const id = active.id;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        api.setSplit(id, latest.current, false);
      });
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !active) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.documentElement.classList.remove('resizing');
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    api.setSplit(active.id, latest.current, true);
  };

  if (!loaded) return <div className="boot" />;

  return (
    <div className={`shell ${fullscreen ? 'fullscreen' : ''}`}>
      <TabBar
        workspaces={state.workspaces}
        activeId={settings?.kind === 'project' ? settings.workspaceId : settings ? null : (active?.id ?? null)}
        onSelect={selectTab}
        onReorder={(ids) => {
          // Optimistic: show the new order immediately; the main process broadcasts the persisted order.
          setState((s) => ({ ...s, workspaces: ids.map((id) => s.workspaces.find((w) => w.id === id)!).filter(Boolean) }));
          void api.reorderWorkspaces(ids);
        }}
        onContextMenu={(id) => void api.workspaceContextMenu(id)}
        onNew={() => {
          setSettings(null);
          setShowStart(true);
        }}
        onClose={(id) =>
          void api.closeWorkspace(id).then((r) => {
            if (!r.ok) toast({ workspaceId: id, kind: 'error', title: 'Tab not closed', body: r.detail ?? '' });
          })
        }
        startOpen={startVisible && !settings}
        onSelectStart={() => {
          setSettings(null);
          setShowStart(true);
        }}
        onCloseStart={() => setShowStart(false)}
        viewMode={!settings && active ? viewMode : null}
        onViewMode={(mode) => active && api.setViewMode(active.id, mode)}
      />

      {settings ? (
        <div className="start-frame" style={{ left: area.x, top: area.y }}>
          {settings.kind === 'project' ? (
            <ProjectSettings key={settings.workspaceId} api={api} workspaceId={settings.workspaceId} refreshKey={state} onClose={closeSettings} />
          ) : (
            <AppSettings api={api} refreshKey={state} onClose={closeSettings} />
          )}
        </div>
      ) : active ? (
        <>
          {view.chatgpt && (
            <div className="chat-placeholder" style={{ left: view.chatgpt.x, top: view.chatgpt.y, width: view.chatgpt.width, height: view.chatgpt.height }}>
              Loading ChatGPT…
            </div>
          )}
          {view.splitter && (
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize ChatGPT and development panes"
              style={{ left: view.splitter.x, top: view.splitter.y, width: view.splitter.width, height: view.splitter.height }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          )}
          <div
            className="devpane-frame"
            style={{ left: devFrame.x, top: devFrame.y, width: devFrame.width, height: devFrame.height, ...(view.devPaneVisible ? {} : { visibility: 'hidden', pointerEvents: 'none' }) }}
          >
            <DevPane workspaces={state.workspaces} active={active} debugMode={state.debugMode} actions={actions} diagnostics={api.diagnostics} />
          </div>
          {view.statusBar && (
            <ClaudeStatusBar
              active={active}
              busy={busy}
              style={{ left: view.statusBar.x, top: view.statusBar.y, width: view.statusBar.width, height: view.statusBar.height }}
              onSend={() => void actions.sendToClaude(active.id)}
              onRetry={() => active.latestReview && actions.retryReview(active.id, active.latestReview.taskId)}
              onStop={() => actions.cancelTask(active.id)}
              onCancelAutoSend={() => actions.cancelAutoSend(active.id)}
              onOpenClaude={() => api.setViewMode(active.id, 'claude-focus')}
            />
          )}
        </>
      ) : (
        <div className="start-frame" style={{ left: area.x, top: area.y }}>
          <StartPage
            projects={state.projects}
            onCreate={openNew}
            onOpen={(id) => {
              setShowStart(false);
              void api.openWorkspace(id);
            }}
            onContextMenu={(id) => void api.projectContextMenu(id)}
            onSettings={() => setSettings({ kind: 'app' })}
          />
        </div>
      )}

      {dialog === 'new' && (
        <NewWorkspaceDialog
          api={api}
          onClose={closeDialog}
        />
      )}
      {dialog === 'coffee' && <CoffeeDialog onBuy={() => void api.openCoffee()} onClose={closeDialog} />}
      {dialog === 'setup' && <SetupDialog api={api} chatgptLoggedIn={chatgptLoggedIn} onClose={closeDialog} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <button
            key={t.id}
            className={`toast ${t.kind}`}
            onClick={() => {
              void api.selectWorkspace(t.workspaceId);
              setToasts((ts) => ts.filter((x) => x.id !== t.id));
            }}
          >
            <b>{t.title}</b>
            <span>{t.body}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
