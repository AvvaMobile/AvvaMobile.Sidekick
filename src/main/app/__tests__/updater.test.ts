import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateService, type UpdaterLike } from '../updater';

function setup(enabled = true, choice = 0, canQuit?: () => boolean) {
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  }) as unknown as UpdaterLike & EventEmitter & { checkForUpdates: ReturnType<typeof vi.fn>; quitAndInstall: ReturnType<typeof vi.fn> };
  const showMessage = vi.fn(async () => choice);
  const service = new UpdateService({ updater, enabled, currentVersion: '0.1.0', showMessage, log: () => {}, canQuit });
  return { updater, showMessage, service };
}

describe('UpdateService', () => {
  it('downloads automatically and installs on quit', () => {
    const { updater } = setup();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('never checks in development', async () => {
    const { updater, service, showMessage } = setup(false);
    service.start();
    await service.check(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledTimes(1);
  });

  it('stays silent when a background check finds nothing', async () => {
    const { updater, service, showMessage } = setup();
    await service.check(false);
    updater.emit('update-not-available');
    updater.emit('error', new Error('offline'));
    expect(showMessage).not.toHaveBeenCalled();
  });

  it('reports "up to date" for a manual check', async () => {
    const { updater, service, showMessage } = setup();
    await service.check(true);
    updater.emit('update-not-available');
    expect(showMessage).toHaveBeenCalledWith(expect.objectContaining({ message: 'Avva Mobile Sidekick is up to date' }));
  });

  it('asks once per version and restarts on Restart Now', async () => {
    const { updater, showMessage } = setup(true, 0);
    updater.emit('update-downloaded', { version: '0.2.0' });
    updater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(1));
    expect(showMessage).toHaveBeenCalledTimes(1);
  });

  it('does not restart on Later', async () => {
    const { updater, showMessage } = setup(true, 1);
    updater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(showMessage).toHaveBeenCalled());
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('Restart Now asks to quit first and keeps running when that is declined', async () => {
    const canQuit = vi.fn(() => false);
    const { updater } = setup(true, 0, canQuit);
    updater.emit('update-downloaded', { version: '0.3.0' });
    await new Promise((r) => setTimeout(r, 0));
    expect(canQuit).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(true);
    canQuit.mockReturnValue(true);
    const b = setup(true, 0, canQuit);
    b.updater.emit('update-downloaded', { version: '0.3.0' });
    await new Promise((r) => setTimeout(r, 0));
    expect(b.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
