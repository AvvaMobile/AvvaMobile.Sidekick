import { execFile } from 'node:child_process';
import { launchCommand } from '../claude/ClaudeRunner';
import type { MicrophoneStatus, ToolCheck } from '../../shared/setup';

/** Runs `<exe> --version`; resolves to its first output line, or null when it cannot run. */
export type VersionProbe = (exe: string, env: NodeJS.ProcessEnv) => Promise<string | null>;

const probeVersion: VersionProbe = (exe, env) =>
  new Promise((resolve) => {
    const launch = launchCommand(exe, ['--version']);
    execFile(launch.file, launch.args, { env, timeout: 10_000, windowsHide: true, windowsVerbatimArguments: launch.verbatim }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).trim().split(/\r?\n/)[0] || '');
    });
  });

/** Claude Code is found when the resolved executable answers `--version`; Git when `git --version` does. */
export async function checkTool(exe: string | null, env: NodeJS.ProcessEnv, probe: VersionProbe = probeVersion): Promise<ToolCheck> {
  if (!exe) return { found: false, version: null };
  const version = await probe(exe, env);
  return version === null ? { found: false, version: null } : { found: true, version: version || null };
}

/** Maps Electron's media access status; platforms without a microphone permission report 'not-needed'. */
export function microphoneStatus(platform: NodeJS.Platform, read: () => string): MicrophoneStatus {
  if (platform !== 'darwin' && platform !== 'win32') return 'not-needed';
  const s = read();
  return s === 'granted' || s === 'denied' || s === 'restricted' || s === 'not-determined' ? s : 'unknown';
}

/** Where the user grants a microphone permission that was denied earlier. */
export function microphoneSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  if (platform === 'win32') return 'ms-settings:privacy-microphone';
  return null;
}
