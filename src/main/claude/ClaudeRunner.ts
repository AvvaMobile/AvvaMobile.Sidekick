import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** What a managed run reports back: the Claude session id, then the turn's final result (D006). */
export type ClaudeStreamEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'result'; isError: boolean; subtype: string; result: string | null; sessionId: string | null };

export interface ClaudeRunRequest {
  taskId: string;
  workspaceId: string;
  cwd: string;
  prompt: string;
  resumeSessionId: string | null;
  onEvent(event: ClaudeStreamEvent): void;
  /** `cancelled`: the run ended because the user interrupted it (not a failure, not a result). */
  onExit(exit: { code: number | null; signal: string | null; spawnError: string | null; cancelled?: boolean }): void;
}

export interface ClaudeRunHandle {
  cancel(): void;
}

/** The managed Claude runner port used by the orchestrator (fakeable in tests). */
export interface ClaudeRunnerPort {
  start(req: ClaudeRunRequest): ClaudeRunHandle;
}

let loginEnvCache: NodeJS.ProcessEnv | null = null;

/**
 * Markers of a *running* Claude Code session (and its private messaging socket/token). When Sidekick
 * itself is started from a Claude Code session they would leak into the terminal and the managed
 * runner: Claude then treats itself as a child session (transcript saving off, resume unreliable) and
 * child processes could reach the parent session's messaging channel. User configuration variables
 * (e.g. CLAUDE_CODE_USE_BEDROCK, ANTHROPIC_*) are kept.
 */
const CLAUDE_SESSION_MARKER = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_[A-Z_]+|SESSION_ID|MESSAGING_[A-Z_]+|BRIDGE_[A-Z_]+|SSE_PORT))$/;

export function withoutClaudeSessionMarkers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!CLAUDE_SESSION_MARKER.test(k)) out[k] = v;
  return out;
}

/** Value of an environment variable; Windows variable names are case-insensitive (`Path` vs `PATH`). */
export function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[key];
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : env[k];
}

/**
 * Environment of the user's login shell. Apps launched from Finder get a minimal PATH; Claude and
 * the tools it runs (git, node, package managers) need the user's normal PATH. Windows has no login
 * shell: GUI apps already get the user's full environment there.
 */
export function loginShellEnv(): NodeJS.ProcessEnv {
  if (loginEnvCache) return loginEnvCache;
  const base = withoutClaudeSessionMarkers(process.env);
  const env: NodeJS.ProcessEnv = { ...base };
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL || '/bin/zsh';
    try {
      const r = spawnSync(shell, ['-l', '-c', 'printf "__WS_ENV__"; env -0'], { encoding: 'utf8', timeout: 5000, env: base });
      const out = r.stdout ?? '';
      const i = out.indexOf('__WS_ENV__');
      if (i >= 0) {
        for (const pair of out.slice(i + '__WS_ENV__'.length).split('\0')) {
          const eq = pair.indexOf('=');
          if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
      }
    } catch {
      // Fall back to the process environment.
    }
  }
  // Never leak Electron's own switches into child tools.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  loginEnvCache = withoutClaudeSessionMarkers(env);
  return loginEnvCache;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolves the Claude Code executable without asking the user (`SIDEKICK_CLAUDE_PATH` override, then PATH, then known install locations). */
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = loginShellEnv(),
  platform: NodeJS.Platform = process.platform,
  canRun: (p: string) => boolean = isExecutable,
): string | null {
  const get = (k: string) => envValue(env, k, platform);
  const override = get('SIDEKICK_CLAUDE_PATH') || get('WORKSPACE_CLAUDE_PATH');
  if (override && canRun(override)) return override;
  const path = platform === 'win32' ? win32 : posix;
  // On Windows only PATHEXT names are runnable (npm also drops an extensionless bash script there).
  const names =
    platform === 'win32'
      ? (get('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => `claude${ext.toLowerCase()}`)
      : ['claude'];
  for (const dir of (get('PATH') ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) if (canRun(path.join(dir, name))) return path.join(dir, name);
  }
  let fallbacks: string[];
  if (platform === 'win32') {
    const home = get('USERPROFILE') || homedir();
    const appData = get('APPDATA') || path.join(home, 'AppData', 'Roaming');
    fallbacks = [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.claude', 'local', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd')];
  } else {
    const home = homedir();
    fallbacks = [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  }
  for (const p of fallbacks) if (canRun(p)) return p;
  return null;
}

/** Quotes one argument for a `cmd.exe /s /c` command line (anything outside the safe set, e.g. `%`, is quoted). */
function cmdQuote(arg: string): string {
  return /^[A-Za-z0-9_\-.:\\/=@+,]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Claude Code session ids are UUIDs; anything else is never passed to `--resume`. */
export function isClaudeSessionId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * How to launch an executable with arguments. Windows cannot spawn `.cmd`/`.bat` shims (npm installs)
 * directly: they run through `cmd.exe /d /s /c "<command line>"`, whose arguments must be passed verbatim.
 */
export function launchCommand(
  exe: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.COMSPEC,
): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(exe)) return { file: exe, args, verbatim: false };
  const line = [`"${exe}"`, ...args.map(cmdQuote)].join(' ');
  return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}
