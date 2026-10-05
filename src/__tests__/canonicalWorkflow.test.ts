import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEW_MODES } from '../domain/layout/viewMode';

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') sources(p, out);
    } else if (/\.(ts|tsx|css|html)$/.test(name)) out.push(p);
  }
  return out;
}
const all = sources(join(__dirname, '..')).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

describe('canonical workflow (D040)', () => {
  it('only the three views exist', () => {
    expect(VIEW_MODES).toEqual(['chatgpt-focus', 'split', 'claude-focus']);
  });

  it('no manual Send to ChatGPT control and no relay buttons remain in the UI code', () => {
    for (const { p, text } of all) {
      expect(text, p).not.toMatch(/Send to ChatGPT/);
      expect(text, p).not.toMatch(/relay-(btn|overlay|view)|RelayView|setRelay/i);
    }
  });

  it('the only handback IPC is Retry, and it has no Claude start path', () => {
    const preload = readFileSync(join(__dirname, '../preload/shell.ts'), 'utf8');
    expect(preload).toContain("'review:retry'");
    expect(preload).not.toContain("'review:send'");
  });

  it('exactly two send paths exist: the block button into Claude and the automatic handback into ChatGPT (D047)', () => {
    for (const { p, text } of all) {
      expect(text, p).not.toMatch(/diag:(insert|submit|state|home)|ResponseCopier|response:(copy|info)|copyResponse|developerMode|SIDEKICK_DEVELOPER/);
    }
    const users = (needle: string) =>
      all.filter(({ p, text }) => text.includes(needle) && !p.endsWith('ChatGPTAdapter.ts')).map(({ p }) => p.replace(/\\/g, '/').replace(/^.*\/src\//, ''));
    // The ChatGPT composer is written to only by the orchestrator's automatic handback.
    expect(users('.insertComposerText(')).toEqual(['main/app/WorkspaceOrchestrator.ts']);
    expect(users('.submitComposer(')).toEqual(['main/app/WorkspaceOrchestrator.ts']);
    // The terminal's Claude receives a managed prompt only through the runner started by the block-button task.
    const preload = readFileSync(join(__dirname, '../preload/shell.ts'), 'utf8');
    expect(preload).not.toMatch(/diagnostics|insert|submit/i);
  });
});
