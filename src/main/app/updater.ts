import type { MessageBoxOptions } from 'electron';

/** The part of electron-updater's autoUpdater this module uses (injected so it can be tested). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateServiceDeps {
  updater: UpdaterLike;
  /** Updates only apply to an installed (packaged) app; development runs never check. */
  enabled: boolean;
  currentVersion: string;
  showMessage: (options: MessageBoxOptions) => Promise<number>;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Asks to quit (e.g. confirms stopping a running Claude task); false keeps the app running. */
  canQuit?: () => boolean;
}

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Background auto-update (D036): checks on launch and every few hours, downloads in the background and
 * asks once per version whether to restart now. A manual "Check for Updates…" also reports
 * "up to date" and errors; background checks stay silent about those.
 */
export class UpdateService {
  private manual = false;
  private promptedVersion: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    const { updater } = deps;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-available', (info) => {
      deps.log('update.available', { version: info.version });
      if (this.manual) void this.deps.showMessage({ type: 'info', message: `Downloading version ${info.version}…`, detail: 'You will be asked to restart when it is ready.' });
      this.manual = false;
    });
    updater.on('update-not-available', () => {
      if (this.manual) void this.deps.showMessage({ type: 'info', message: 'Avva Mobile Sidekick is up to date', detail: `Version ${deps.currentVersion}` });
      this.manual = false;
    });
    updater.on('update-downloaded', (info) => void this.promptRestart(info.version));
    updater.on('error', (error) => {
      deps.log('update.error', { message: error.message });
      if (this.manual) void this.deps.showMessage({ type: 'error', message: 'Could not check for updates', detail: error.message });
      this.manual = false;
    });
  }

  start(): void {
    if (!this.deps.enabled || this.timer) return;
    void this.check(false);
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(manual = true): Promise<void> {
    if (!this.deps.enabled) {
      if (manual) await this.deps.showMessage({ type: 'info', message: 'Updates are only available in the installed app', detail: `Version ${this.deps.currentVersion} (development)` });
      return;
    }
    this.manual = manual;
    try {
      await this.deps.updater.checkForUpdates();
    } catch {
      // Reported through the 'error' event.
    }
  }

  private async promptRestart(version: string): Promise<void> {
    if (this.promptedVersion === version) return;
    this.promptedVersion = version;
    this.deps.log('update.downloaded', { version });
    const choice = await this.deps.showMessage({
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Version ${version} is ready to install`,
      detail: 'Restart Avva Mobile Sidekick to finish updating. If you choose Later, it is installed the next time you quit.',
    });
    if (choice !== 0) return;
    // Declined (Claude is still working): the update stays downloaded and installs on the next quit.
    if (this.deps.canQuit && !this.deps.canQuit()) return;
    this.deps.updater.quitAndInstall();
  }
}
