import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOPBAR_HEIGHT, workAreaFor } from '../shared/shellLayout';

/**
 * Regression guard: a window drag region that overlaps the ChatGPT WebContentsView makes macOS swallow
 * clicks on ChatGPT controls near its top edge (ChatGPT sidebar toggle was unclickable). The tab strip is
 * the title bar, so it is the only drag region, and the work area (where the view lives) starts below it.
 */
const SRC = join(__dirname, '..');

describe('shell window chrome', () => {
  it('merges the tab strip into the title bar with an inset title bar', () => {
    const shell = readFileSync(join(SRC, 'main/app/ShellApp.ts'), 'utf8');
    expect(shell).toMatch(/titleBarStyle:\s*'hiddenInset'/);
    expect(shell).not.toMatch(/frame:\s*false/);
  });

  it('on Windows hides the title bar and overlays the caption buttons on the strip', () => {
    const shell = readFileSync(join(SRC, 'main/app/ShellApp.ts'), 'utf8');
    expect(shell).toMatch(/titleBarStyle:\s*'hidden'/);
    expect(shell).toMatch(/titleBarOverlay:/);
    const css = readFileSync(join(SRC, 'renderer/shell/styles.css'), 'utf8');
    expect(css).toMatch(/html\.platform-win32 \.topbar\s*\{[^}]*padding:\s*0 140px/);
  });

  it('declares window drag regions only on the tab strip', () => {
    const css = readFileSync(join(SRC, 'renderer/shell/styles.css'), 'utf8');
    const rules = css.split('\n').filter((l) => /app-region\s*:\s*drag/.test(l));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.trimStart()).toMatch(/^\.topbar\s*\{/);
  });

  it('keeps the work area (ChatGPT view) below the tab strip', () => {
    expect(workAreaFor(1500, 940).y).toBeGreaterThanOrEqual(TOPBAR_HEIGHT);
  });
});
