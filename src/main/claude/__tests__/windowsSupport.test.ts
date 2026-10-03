import { describe, expect, it } from 'vitest';
import { envValue, isClaudeSessionId, launchCommand, resolveClaudeExecutable, withoutClaudeSessionMarkers } from '../ClaudeRunner';
import { hookCommand, hookSettings, windowsHookDir, WINDOWS_STOP_HOOK_SCRIPT } from '../StopHookChannel';

const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe('resolveClaudeExecutable', () => {
  it('darwin: finds claude on PATH (colon-separated)', () => {
    expect(resolveClaudeExecutable({ PATH: '/usr/bin:/opt/homebrew/bin' }, 'darwin', only('/opt/homebrew/bin/claude'))).toBe('/opt/homebrew/bin/claude');
  });

  it('darwin: falls back to Homebrew when PATH has no claude', () => {
    expect(resolveClaudeExecutable({ PATH: '/usr/bin' }, 'darwin', only('/opt/homebrew/bin/claude'))).toBe('/opt/homebrew/bin/claude');
  });

  it('honors SIDEKICK_CLAUDE_PATH (and the legacy WORKSPACE_CLAUDE_PATH)', () => {
    expect(resolveClaudeExecutable({ SIDEKICK_CLAUDE_PATH: '/x/claude', PATH: '' }, 'darwin', only('/x/claude'))).toBe('/x/claude');
    expect(resolveClaudeExecutable({ WORKSPACE_CLAUDE_PATH: '/x/claude', PATH: '' }, 'darwin', only('/x/claude'))).toBe('/x/claude');
    expect(resolveClaudeExecutable({ SIDEKICK_CLAUDE_PATH: '/s/claude', WORKSPACE_CLAUDE_PATH: '/x/claude', PATH: '' }, 'darwin', only('/s/claude', '/x/claude'))).toBe('/s/claude');
  });

  it('win32: reads Path case-insensitively, splits on ";" and tries PATHEXT extensions in order', () => {
    const env = { Path: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const exists = only('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude');
    expect(resolveClaudeExecutable(env, 'win32', exists)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  });

  it('win32: prefers claude.exe over claude.cmd in the same directory', () => {
    const exists = only('C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe');
    expect(resolveClaudeExecutable({ PATH: 'C:\\bin' }, 'win32', exists)).toBe('C:\\bin\\claude.exe');
  });

  it('win32: falls back to the native installer and the npm global shim', () => {
    const env = { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', PATH: '' };
    expect(resolveClaudeExecutable(env, 'win32', only('C:\\Users\\me\\.local\\bin\\claude.exe'))).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
    expect(resolveClaudeExecutable(env, 'win32', only('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'))).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    expect(resolveClaudeExecutable(env, 'win32', () => false)).toBeNull();
  });

  it('envValue is case-sensitive outside Windows', () => {
    expect(envValue({ Path: 'x' }, 'PATH', 'darwin')).toBeUndefined();
    expect(envValue({ Path: 'x' }, 'PATH', 'win32')).toBe('x');
  });
});

describe('launchCommand', () => {
  it('runs executables directly', () => {
    expect(launchCommand('/usr/local/bin/claude', ['-p'], 'darwin')).toEqual({ file: '/usr/local/bin/claude', args: ['-p'], verbatim: false });
    expect(launchCommand('C:\\bin\\claude.exe', ['-p'], 'win32')).toEqual({ file: 'C:\\bin\\claude.exe', args: ['-p'], verbatim: false });
  });

  it('runs .cmd shims through cmd.exe with a quoted verbatim command line', () => {
    const l = launchCommand('C:\\Program Files\\npm\\claude.cmd', ['--settings', 'C:\\a b\\s.json', '--model', 'opus'], 'win32', 'C:\\Windows\\system32\\cmd.exe');
    expect(l.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(l.verbatim).toBe(true);
    expect(l.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\npm\\claude.cmd" --settings "C:\\a b\\s.json" --model opus"']);
  });
});

describe('Stop hook command', () => {
  it('keeps the POSIX command outside Windows', () => {
    const cmd = hookCommand('darwin');
    expect(cmd).toContain('cat > "$SIDEKICK_EVENTS_DIR/');
    expect(cmd).toContain('mv ');
  });

  it('on Windows runs the PowerShell script with a single-quoted forward-slash path (literal in Git Bash and PowerShell)', () => {
    const cmd = hookCommand('win32', 'C:\\Users\\me\\AppData\\Roaming\\Workspace\\hook-events\\stop-hook.ps1');
    expect(cmd).toBe("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:/Users/me/AppData/Roaming/Workspace/hook-events/stop-hook.ps1'");
    expect(cmd).not.toMatch(/[\\&|<>"]/);
    // `$` and backticks stay literal inside single quotes in both shells.
    expect(hookCommand('win32', 'C:\\Users\\$x`y\\h.ps1', 'prompt')).toBe("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 'C:/Users/$x`y/h.ps1' prompt");
    expect(() => hookCommand('win32', "C:\\Users\\O'Brien\\h.ps1")).toThrow();
  });

  it('a profile path with an apostrophe puts the hook script under ProgramData', () => {
    expect(windowsHookDir('C:\\Users\\me\\AppData\\Roaming\\AvvaMobile.Sidekick\\hook-events', {})).toBe('C:\\Users\\me\\AppData\\Roaming\\AvvaMobile.Sidekick\\hook-events');
    expect(windowsHookDir("C:\\Users\\O'Brien\\AppData\\hook-events", { ProgramData: 'C:\\ProgramData' })).toBe('C:\\ProgramData\\AvvaMobile.Sidekick\\hooks');
    expect(() => windowsHookDir("C:\\Users\\O'Brien\\x", { ProgramData: "D:\\it's" })).toThrow();
  });

  it('cmd.exe arguments containing % are quoted', () => {
    const l = launchCommand('C:\\npm\\claude.cmd', ['--settings', 'C:\\100%\\s.json'], 'win32', 'cmd.exe');
    expect(l.args[3]).toBe('""C:\\npm\\claude.cmd" --settings "C:\\100%\\s.json""');
  });

  it('wraps the commands as Stop and UserPromptSubmit hooks in --settings JSON', () => {
    type Hooks = Array<{ hooks: Array<{ type: string; command: string }> }>;
    const j = JSON.parse(hookSettings('win32', 'C:\\h.ps1')) as { hooks: { Stop: Hooks; UserPromptSubmit: Hooks } };
    expect(j.hooks.Stop[0]!.hooks[0]).toEqual({ type: 'command', command: hookCommand('win32', 'C:\\h.ps1') });
    expect(j.hooks.UserPromptSubmit[0]!.hooks[0]).toEqual({ type: 'command', command: hookCommand('win32', 'C:\\h.ps1', 'prompt') });
    expect(hookCommand('darwin', '', 'prompt')).toContain('"$SIDEKICK_EVENTS_DIR/prompt-$$-');
  });

  it('isClaudeSessionId accepts only UUIDs', () => {
    expect(isClaudeSessionId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isClaudeSessionId('x" & calc & "')).toBe(false);
    expect(isClaudeSessionId('%PATH%')).toBe(false);
    expect(isClaudeSessionId(null)).toBe(false);
  });

  it('the Windows script writes a temporary file then renames it to a .json event', () => {
    expect(WINDOWS_STOP_HOOK_SCRIPT).toContain('$env:SIDEKICK_EVENTS_DIR');
    expect(WINDOWS_STOP_HOOK_SCRIPT.indexOf('WriteAllText($tmp')).toBeLessThan(WINDOWS_STOP_HOOK_SCRIPT.indexOf('Move($tmp, $out)'));
    expect(WINDOWS_STOP_HOOK_SCRIPT).toMatch(/\.json"\)/);
  });
});

describe('child environment', () => {
  it('drops running-session markers but keeps user configuration', () => {
    const env = withoutClaudeSessionMarkers({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/x',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'low',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'm',
    });
    expect(env).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'm' });
  });
});
