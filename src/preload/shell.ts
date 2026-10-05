import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * Preload for the trusted local Workspace shell only. Never attached to remote content.
 * Exposes a fixed set of named operations; no generic channel access (ARCHITECTURE §14).
 */
const PUSH = {
  state: 'shell:state',
  terminalData: 'shell:terminal-data',
  toast: 'shell:toast',
  command: 'shell:command',
  openSettings: 'shell:open-settings',
} as const;

const subscribe = (channel: (typeof PUSH)[keyof typeof PUSH], cb: (payload: unknown) => void) => {
  const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};

const str = (v: unknown) => String(v);

contextBridge.exposeInMainWorld('workspace', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('shell:get-state'),
  terminalSnapshot: (id: string) => ipcRenderer.invoke('shell:terminal-snapshot', str(id)),
  setOverlay: (on: boolean) => ipcRenderer.invoke('shell:set-overlay', on === true),

  selectWorkspace: (id: string) => ipcRenderer.invoke('workspace:select', str(id)),
  workspaceContextMenu: (id: string) => ipcRenderer.invoke('workspace:context-menu', str(id)),
  reorderWorkspaces: (ids: string[]) => ipcRenderer.invoke('workspace:reorder', Array.isArray(ids) ? ids.map(str) : []),
  pickFolder: () => ipcRenderer.invoke('workspace:pick-folder'),
  createWorkspace: (name: string, projectPath: string) => ipcRenderer.invoke('workspace:create', { name: str(name), projectPath: str(projectPath) }),
  removeWorkspace: (id: string) => ipcRenderer.invoke('workspace:remove', str(id)),
  closeWorkspace: (id: string) => ipcRenderer.invoke('workspace:close', str(id)),
  setModel: (id: string, model: string) => ipcRenderer.invoke('workspace:set-model', str(id), str(model)),
  setEffort: (id: string, effort: string | null) => ipcRenderer.invoke('workspace:set-effort', str(id), effort === null ? null : str(effort)),
  openWorkspace: (id: string) => ipcRenderer.invoke('workspace:open', str(id)),
  projectContextMenu: (id: string) => ipcRenderer.invoke('project:context-menu', str(id)),
  getProjectSettings: (id: string) => ipcRenderer.invoke('workspace:get-settings', str(id)),
  // The patch is validated strictly in the main process; only a plain object is forwarded.
  updateProjectSettings: (id: string, patch: unknown) => ipcRenderer.invoke('workspace:update-settings', str(id), patch && typeof patch === 'object' ? patch : {}),
  verifyGithub: (id: string) => ipcRenderer.invoke('workspace:verify-github', str(id)),
  chooseIcon: (id: string) => ipcRenderer.invoke('workspace:choose-icon', str(id)),
  getAppSettings: () => ipcRenderer.invoke('app:get-settings'),
  updateAppSettings: (patch: unknown) => ipcRenderer.invoke('app:update-settings', patch && typeof patch === 'object' ? patch : {}),
  revealUserData: () => ipcRenderer.invoke('app:reveal-user-data'),

  sendToClaude: (id: string) => ipcRenderer.invoke('handoff:send', str(id)),
  cancelAutoSend: (id: string) => ipcRenderer.invoke('handoff:cancel-auto', str(id)),
  cancelTask: (id: string) => ipcRenderer.invoke('task:cancel', str(id)),
  resetSession: (id: string) => ipcRenderer.invoke('session:reset', str(id)),
  responseInfo: (id: string) => ipcRenderer.invoke('response:info', str(id)),
  // target: 'auto' | 'full' | { block: n }; validated in the main process.
  copyResponse: (id: string, target: unknown) => ipcRenderer.invoke('response:copy', str(id), target),
  retryReview: (id: string, taskId: string) => ipcRenderer.invoke('review:retry', str(id), str(taskId)),

  terminalInput: (id: string, data: string) => ipcRenderer.send('terminal:input', { workspaceId: str(id), data: str(data) }),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', { workspaceId: str(id), cols: Math.floor(Number(cols)), rows: Math.floor(Number(rows)) }),
  terminalRestart: (id: string) => ipcRenderer.invoke('terminal:restart', str(id)),
  openCoffee: () => ipcRenderer.invoke('app:open-coffee'),
  checkSetup: () => ipcRenderer.invoke('app:check-setup'),
  openSetupLink: (key: string) => ipcRenderer.invoke('app:open-setup-link', str(key)),
  requestMicrophone: () => ipcRenderer.invoke('app:request-microphone'),
  setSplit: (id: string, ratio: number, commit: boolean) => ipcRenderer.send('layout:set-split', { workspaceId: str(id), ratio: Number(ratio), commit: commit === true }),
  setViewMode: (id: string, mode: string) => ipcRenderer.send('layout:set-view', { workspaceId: str(id), mode: str(mode) }),

  diagnostics: {
    state: () => ipcRenderer.invoke('diag:state'),
    capture: () => ipcRenderer.invoke('diag:capture'),
    latestUser: () => ipcRenderer.invoke('diag:latest-user'),
    micStatus: () => ipcRenderer.invoke('diag:mic-status'),
    home: () => ipcRenderer.invoke('diag:home'),
    insert: (text: string) => ipcRenderer.invoke('diag:insert', str(text)),
    submit: () => ipcRenderer.invoke('diag:submit'),
  },

  onState: (cb: (s: unknown) => void) => subscribe(PUSH.state, cb),
  onTerminalData: (cb: (e: unknown) => void) => subscribe(PUSH.terminalData, cb),
  onToast: (cb: (t: unknown) => void) => subscribe(PUSH.toast, cb),
  onCommand: (cb: (c: unknown) => void) => subscribe(PUSH.command, cb),
  onOpenSettings: (cb: (t: unknown) => void) => subscribe(PUSH.openSettings, cb),
});
