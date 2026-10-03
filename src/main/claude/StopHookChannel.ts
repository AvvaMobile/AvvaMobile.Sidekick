import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join, win32 } from 'node:path';

export interface StopEvent {
  sessionId: string | null;
  transcriptPath: string | null;
  lastAssistantMessage: string | null;
}

/** A prompt was submitted to the interactive Claude (`UserPromptSubmit` hook); `prompt` may be missing. */
export interface PromptSubmitEvent {
  sessionId: string | null;
  prompt: string | null;
}

/** Hook events Claude Code reports through the per-Workspace channel. */
export type HookEventKind = 'stop' | 'prompt';

/**
 * Receives Claude Code `Stop` and `UserPromptSubmit` hook payloads from the interactive Claude running in
 * a Workspace's terminal. The hooks (see `hookSettings`) drop one JSON file per event into the Workspace's
 * own directory; this class watches that directory. Completion of a managed task comes only from here.
 */
export class StopHookChannel {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly listeners = new Map<string, Set<(e: StopEvent) => void>>();
  private readonly promptListeners = new Map<string, Set<(e: PromptSubmitEvent) => void>>();
  private readonly interruptListeners = new Map<string, Set<() => void>>();
  /** Workspaces whose Claude reported a submitted prompt and no Stop since (a turn is in progress). */
  private readonly busy = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Windows: writes the PowerShell hook script and a `--settings` file that runs it (a file avoids
   * passing JSON through the Windows command line / cmd.exe), only when their content changed.
   * Returns the settings file path; throws when they cannot be written.
   */
  windowsSettingsFile(): string {
    const dir = windowsHookDir(this.root, this.env);
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'stop-hook.ps1');
    writeIfChanged(script, WINDOWS_STOP_HOOK_SCRIPT);
    const settings = join(dir, 'stop-hook-settings.json');
    writeIfChanged(settings, hookSettings('win32', script));
    return settings;
  }

  dirFor(workspaceId: string): string {
    return join(this.root, workspaceId);
  }

  /** Starts watching a Workspace's event directory (idempotent; a new terminal process is idle). Returns the directory. */
  open(workspaceId: string): string {
    const dir = this.dirFor(workspaceId);
    mkdirSync(dir, { recursive: true });
    this.busy.delete(workspaceId);
    if (!this.watchers.has(workspaceId)) {
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true }); // stale events from an earlier run
      const w = watch(dir, () => this.drain(workspaceId));
      w.on('error', () => {});
      this.watchers.set(workspaceId, w);
    }
    return dir;
  }

  close(workspaceId: string): void {
    this.watchers.get(workspaceId)?.close();
    this.watchers.delete(workspaceId);
    this.listeners.delete(workspaceId);
    this.promptListeners.delete(workspaceId);
    this.interruptListeners.delete(workspaceId);
    this.busy.delete(workspaceId);
  }

  closeAll(): void {
    for (const id of [...this.watchers.keys()]) this.close(id);
  }

  /** Subscribes to Stop events of one Workspace. Returns an unsubscribe function. */
  onStop(workspaceId: string, cb: (e: StopEvent) => void): () => void {
    let set = this.listeners.get(workspaceId);
    if (!set) this.listeners.set(workspaceId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Subscribes to UserPromptSubmit events of one Workspace. Returns an unsubscribe function. */
  onPromptSubmit(workspaceId: string, cb: (e: PromptSubmitEvent) => void): () => void {
    let set = this.promptListeners.get(workspaceId);
    if (!set) this.promptListeners.set(workspaceId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Claude is in the middle of a turn: a prompt was submitted and no Stop followed yet. */
  isBusy(workspaceId: string): boolean {
    return this.busy.has(workspaceId);
  }

  /** The turn was interrupted (Escape / Ctrl+C), which ends it without a Stop event. */
  markIdle(workspaceId: string): void {
    this.busy.delete(workspaceId);
  }

  /** Subscribes to user interrupts (Escape / Ctrl+C typed into the terminal) of one Workspace. Returns an unsubscribe function. */
  onInterrupt(workspaceId: string, cb: () => void): () => void {
    let set = this.interruptListeners.get(workspaceId);
    if (!set) this.interruptListeners.set(workspaceId, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /**
   * The user pressed Escape / Ctrl+C in the terminal: the turn ends without a Stop event, so the busy
   * mark is cleared and a managed run waiting for its Stop learns that it was interrupted.
   */
  interrupt(workspaceId: string): void {
    this.markIdle(workspaceId);
    for (const cb of [...(this.interruptListeners.get(workspaceId) ?? [])]) cb();
  }

  /** Delivers one parsed hook payload (exposed for tests; the watcher calls it for every event file). */
  dispatch(workspaceId: string, raw: string, fileKind: HookEventKind = 'stop'): void {
    const ev = parseHookPayload(raw, fileKind);
    if (!ev) return;
    if (ev.kind === 'prompt') {
      this.busy.add(workspaceId);
      for (const cb of [...(this.promptListeners.get(workspaceId) ?? [])]) cb(ev.event);
    } else {
      this.busy.delete(workspaceId);
      for (const cb of [...(this.listeners.get(workspaceId) ?? [])]) cb(ev.event);
    }
  }

  private drain(workspaceId: string): void {
    const dir = this.dirFor(workspaceId);
    let files: Array<{ name: string; at: number; kind: HookEventKind }>;
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((name) => ({ name, at: statSync(join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0, kind: fileKindOf(name) }));
    } catch {
      return;
    }
    // Oldest first; a prompt always precedes the Stop of its own turn.
    files.sort((a, b) => a.at - b.at || (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'prompt' ? -1 : 1));
    for (const f of files) {
      const p = join(dir, f.name);
      let raw: string;
      try {
        raw = readFileSync(p, 'utf8');
        rmSync(p, { force: true });
      } catch {
        continue;
      }
      this.dispatch(workspaceId, raw, f.kind);
    }
  }
}

const fileKindOf = (name: string): HookEventKind => (name.startsWith('prompt-') ? 'prompt' : 'stop');

function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    // missing: write it
  }
  writeFileSync(path, content);
}

/**
 * Directory of the Windows hook script. Its path is single-quoted in the hook command (literal in both
 * Git Bash and PowerShell), which cannot represent a `'`: such a profile path falls back to ProgramData.
 */
export function windowsHookDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!root.includes("'")) return root;
  const fallback = win32.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'AvvaMobile.Sidekick', 'hooks');
  if (fallback.includes("'")) throw new Error('The app data folder path contains an apostrophe; the Claude hook cannot be installed.');
  return fallback;
}

/** Parses a hook payload; `hook_event_name` decides the kind, otherwise the event file's name does. */
export function parseHookPayload(raw: string, fileKind: HookEventKind = 'stop'): { kind: 'stop'; event: StopEvent } | { kind: 'prompt'; event: PromptSubmitEvent } | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const kind = j.hook_event_name === 'UserPromptSubmit' ? 'prompt' : j.hook_event_name === 'Stop' ? 'stop' : fileKind;
    if (kind === 'prompt') return { kind, event: { sessionId: str(j.session_id), prompt: str(j.prompt) } };
    return { kind, event: { sessionId: str(j.session_id), transcriptPath: str(j.transcript_path), lastAssistantMessage: str(j.last_assistant_message) } };
  } catch {
    return null;
  }
}

export function parseStopPayload(raw: string): StopEvent | null {
  const ev = parseHookPayload(raw, 'stop');
  return ev?.kind === 'stop' ? ev.event : null;
}

/** Text of the last assistant turn in a Claude transcript (JSONL). */
export function lastAssistantText(transcript: string): string | null {
  let found: string | null = null;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (j.type === 'user' && typeof j.message?.content === 'string') found = null; // a new prompt starts a new turn
      if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
      const text = (j.message!.content as Array<{ type?: string; text?: string }>)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) found = text;
    } catch {
      // partial line
    }
  }
  return found;
}

/**
 * Windows hook (Stop and UserPromptSubmit; the event kind is the first argument): reads the payload (UTF-8)
 * from stdin and atomically drops it into `$env:SIDEKICK_EVENTS_DIR` (temporary file, then rename) so the
 * watcher never reads a partial file.
 */
export const WINDOWS_STOP_HOOK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$dir = $env:SIDEKICK_EVENTS_DIR',
  'if (-not $dir) { exit 0 }',
  "$prefix = if ($args.Count -gt 0 -and $args[0] -eq 'prompt') { 'prompt-' } else { '' }",
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)',
  '$text = $reader.ReadToEnd()',
  '$tmp = Join-Path $dir ".$PID.tmp"',
  '$out = Join-Path $dir ("$prefix$PID-" + (Get-Random) + ".json")',
  '[System.IO.File]::WriteAllText($tmp, $text, $utf8)',
  '[System.IO.File]::Move($tmp, $out)',
  '',
].join('\r\n');

/**
 * Shell command of a hook (`event`: Stop or UserPromptSubmit, whose event files start with `prompt-`).
 * macOS/Linux: POSIX shell. Windows: Claude Code runs hook commands in Git Bash, or PowerShell when Git Bash
 * is missing, so the command must parse identically in both: a bare `powershell.exe` invocation with a
 * single-quoted forward-slash script path (literal in both shells; it must not contain `'`) does.
 */
export function hookCommand(platform: NodeJS.Platform = process.platform, windowsScript = '', event: HookEventKind = 'stop'): string {
  if (platform === 'win32') {
    const path = windowsScript.replace(/\\/g, '/');
    if (path.includes("'")) throw new Error('hook script path must not contain an apostrophe');
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${path}'${event === 'prompt' ? ' prompt' : ''}`;
  }
  const prefix = event === 'prompt' ? 'prompt-' : '';
  return `cat > "$SIDEKICK_EVENTS_DIR/.$$.tmp" && mv "$SIDEKICK_EVENTS_DIR/.$$.tmp" "$SIDEKICK_EVENTS_DIR/${prefix}$$-$RANDOM.json"`;
}

/** `--settings` JSON that adds the Stop and UserPromptSubmit hooks to the user's own configuration (hooks are merged, not replaced). */
export function hookSettings(platform: NodeJS.Platform = process.platform, windowsScript = ''): string {
  const entry = (event: HookEventKind) => [{ hooks: [{ type: 'command', command: hookCommand(platform, windowsScript, event) }] }];
  return JSON.stringify({ hooks: { Stop: entry('stop'), UserPromptSubmit: entry('prompt') } });
}
