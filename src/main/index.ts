import { app, BrowserWindow, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrateLegacyProfile } from './app/profileMigration';
import { startShell } from './app/ShellApp';

const APP_NAME = 'Avva Mobile Sidekick';
app.setName(APP_NAME);
// Windows groups taskbar entries and attributes notifications by this id.
if (process.platform === 'win32') app.setAppUserModelId('com.avvamobile.sidekick');
// Profile (Workspaces, ChatGPT login, logs) in appData/AvvaMobile.Sidekick (D035). The folder used before the
// rename ("Workspace") is moved there once so nothing is lost. SIDEKICK_USER_DATA (or the older
// WORKSPACE_USER_DATA) selects a separate profile for development/automated checks.
const customProfile = process.env.SIDEKICK_USER_DATA || process.env.WORKSPACE_USER_DATA;
const profile = join(app.getPath('appData'), 'AvvaMobile.Sidekick');
if (!customProfile) migrateLegacyProfile(join(app.getPath('appData'), 'Workspace'), profile);
app.setPath('userData', customProfile || profile);

// Global hardening that applies to every webContents (local and remote).
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

// One Sidekick instance per profile: a second launch focuses the running one instead of
// starting a second set of ChatGPT views, terminals and Claude runners on the same state file.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
let focusMainWindow: (() => void) | null = null;
app.on('second-instance', () => {
  if (focusMainWindow) return focusMainWindow();
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
process.on('SIGTERM', () => app.quit());

app.whenReady().then(async () => {
  // Development runs use the stock Electron bundle; show the product icon in the Dock anyway.
  const icon = join(__dirname, '../../build/icon.png');
  if (process.platform === 'darwin' && existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
  ({ focusMainWindow } = await startShell());
});

app.on('window-all-closed', () => app.quit());
