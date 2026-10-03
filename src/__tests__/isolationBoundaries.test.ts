import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDiagnosticsLog } from '../main/diagnostics/diagnosticsLog';
import { DevelopmentPaneRegistry } from '../main/development/DevelopmentPane';
import { HandoffController } from '../main/orchestration/HandoffController';

/**
 * D022: ChatGPT planning activity and the Claude/terminal development pane are isolated.
 * These checks keep the ChatGPT side from ever gaining a path into the pane, PTY or task launch.
 */
const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** ChatGPT-side code: adapter, page scripts, remote view/security policy, diagnostics. */
const CHATGPT_SIDE = ['main/chatgpt', 'main/security', 'main/diagnostics'].flatMap((d) => files(join(SRC, d)));
const FORBIDDEN_IMPORTS = [/from ['"][^'"]*\/development\//, /from ['"][^'"]*\/orchestration\//, /node-pty/, /xterm/];

describe('ChatGPT / development pane isolation (D022)', () => {
  it('ChatGPT-side modules do not import the development pane, PTY, terminal or orchestration', () => {
    expect(CHATGPT_SIDE.length).toBeGreaterThan(5);
    const offenders = CHATGPT_SIDE.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return FORBIDDEN_IMPORTS.filter((re) => re.test(text)).map((re) => `${relative(SRC, f)} ~ ${re}`);
    });
    expect(offenders).toEqual([]);
  });

  it('main process never pushes ChatGPT/diagnostic events to a renderer from ChatGPT-side code', () => {
    const offenders = CHATGPT_SIDE.filter((f) => /webContents\.send\(/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it('shell renderer never receives ChatGPT diagnostics: no diag log push channel exists', () => {
    const preload = readFileSync(join(SRC, 'preload/shell.ts'), 'utf8');
    expect(preload).not.toMatch(/diag(nostics)?:log|onLog/);
    const shellApp = readFileSync(join(SRC, 'main/app/ShellApp.ts'), 'utf8');
    // diag(...) output goes to the diagnostics file only; it is never sent to the window.
    expect(shellApp).not.toMatch(/webContents\.send\([^)]*diag/);
  });

  it('ChatGPT message activity + diagnostics do not touch any terminal buffer, PTY or task launch', () => {
    const panes = new DevelopmentPaneRegistry();
    const ptyA = { write: vi.fn() };
    const ptyB = { write: vi.fn() };
    panes.ensure('a');
    panes.ensure('b');
    panes.attachPty('a', ptyA);
    panes.attachPty('b', ptyB);
    panes.writeOutput('b', 'pty', 'b$ ');
    const outputs = vi.fn();
    panes.onEvent(outputs);
    const handoff = new HandoffController();
    const diag = createDiagnosticsLog(join(mkdtempSync(join(tmpdir(), 'ws-diag-')), 'events.log'), { console: false });

    // Simulate a normal ChatGPT exchange in workspace "a": navigation, permission checks, streaming reply.
    diag('did-navigate-in-page https://chatgpt.com/c/123');
    diag('permission check clipboard-sanitized-write https://chatgpt.com -> ALLOW');
    for (let i = 0; i < 10; i++)
      handoff.observeCandidate('a', { text: `reply ${i}`, messageId: 'm', conversationUrl: null, truncated: false, capturedAt: '' });

    expect(readFileSync(diag.file, 'utf8')).toContain('did-navigate-in-page');
    expect(ptyA.write).not.toHaveBeenCalled();
    expect(ptyB.write).not.toHaveBeenCalled();
    expect(outputs).not.toHaveBeenCalled();
    expect(panes.snapshot('a')).toBe('');
    expect(panes.snapshot('b')).toBe('b$ ');
    expect(handoff.getCandidate('a')?.text).toBe('reply 9');
  });
});
