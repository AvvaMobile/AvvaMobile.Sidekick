import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Internal diagnostics for ChatGPT view / adapter / IPC / navigation / permission events.
 *
 * Goes to a bounded local file and, when enabled (`diagConsoleEnabled`), to the main-process stdout.
 * It never reaches any renderer surface and must never be routed into the development pane (D022).
 */
export interface DiagnosticsLog {
  (line: string): void;
  readonly file: string;
}

const MAX_BYTES = 5_000_000;

/** `SIDEKICK_DIAG_CONSOLE=1` (or the older `WORKSPACE_DIAG_CONSOLE=1`) also prints diagnostics to stdout. */
export function diagConsoleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SIDEKICK_DIAG_CONSOLE || env.WORKSPACE_DIAG_CONSOLE) === '1';
}

export function createDiagnosticsLog(file: string, opts: { console?: boolean } = {}): DiagnosticsLog {
  mkdirSync(dirname(file), { recursive: true });
  const toConsole = opts.console ?? diagConsoleEnabled();
  const log = (line: string) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, entry);
    } catch {
      // Diagnostics must never break the app.
    }
    if (toConsole) process.stdout.write(`[diag] ${entry}`);
  };
  return Object.assign(log, { file });
}
