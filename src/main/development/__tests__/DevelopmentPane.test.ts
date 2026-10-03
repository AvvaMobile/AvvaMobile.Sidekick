import { describe, expect, it, vi } from 'vitest';
import { DevelopmentPaneRegistry, type DevPaneOutputSource } from '../DevelopmentPane';

describe('DevelopmentPaneRegistry', () => {
  it('keeps each workspace terminal buffer isolated', () => {
    const r = new DevelopmentPaneRegistry();
    r.ensure('a');
    r.ensure('b');
    r.writeOutput('a', 'pty', '$ ls\n');
    r.writeOutput('b', 'pty', 'editing file');
    expect(r.snapshot('a')).toBe('$ ls\n');
    expect(r.snapshot('b')).toBe('editing file');
  });

  it('user input goes only to that workspace PTY, never directly into any buffer', () => {
    const r = new DevelopmentPaneRegistry();
    const ptyA = { write: vi.fn() };
    const ptyB = { write: vi.fn() };
    r.ensure('a');
    r.ensure('b');
    r.attachPty('a', ptyA);
    r.attachPty('b', ptyB);
    r.writeUserInput('a', 'git status\r');
    expect(ptyA.write).toHaveBeenCalledWith('git status\r');
    expect(ptyB.write).not.toHaveBeenCalled();
    expect(r.snapshot('a')).toBe('');
  });

  it('rejects any non-terminal source (e.g. ChatGPT diagnostics)', () => {
    const r = new DevelopmentPaneRegistry();
    r.ensure('a');
    for (const bad of ['chatgpt', 'diagnostics', 'adapter', 'ipc', 'dom', 'managed-claude']) {
      expect(() => r.writeOutput('a', bad as DevPaneOutputSource, 'x')).toThrow(/illegal/);
    }
    expect(r.snapshot('a')).toBe('');
  });

  it('rejects writes to unknown workspaces instead of falling back to another', () => {
    const r = new DevelopmentPaneRegistry();
    r.ensure('a');
    expect(() => r.writeOutput('b', 'pty', 'x')).toThrow();
    expect(r.snapshot('a')).toBe('');
  });

  it('emits events tagged with the workspace', () => {
    const r = new DevelopmentPaneRegistry();
    r.ensure('a');
    const seen = vi.fn();
    r.onEvent(seen);
    r.writeOutput('a', 'pty', 'hi');
    expect(seen.mock.calls).toEqual([[{ workspaceId: 'a', data: 'hi' }]]);
  });

  it('bounds the buffer', () => {
    const r = new DevelopmentPaneRegistry(10);
    r.ensure('a');
    r.writeOutput('a', 'pty', '0123456789abc');
    expect(r.snapshot('a')).toBe('3456789abc');
  });
});
