import { describe, expect, it } from 'vitest';
import { diagConsoleEnabled } from '../diagnosticsLog';

describe('diagnostics console switch', () => {
  it('reads SIDEKICK_DIAG_CONSOLE, falling back to the older WORKSPACE_DIAG_CONSOLE', () => {
    expect(diagConsoleEnabled({})).toBe(false);
    expect(diagConsoleEnabled({ SIDEKICK_DIAG_CONSOLE: '1' })).toBe(true);
    expect(diagConsoleEnabled({ WORKSPACE_DIAG_CONSOLE: '1' })).toBe(true);
    expect(diagConsoleEnabled({ SIDEKICK_DIAG_CONSOLE: '0', WORKSPACE_DIAG_CONSOLE: '1' })).toBe(false);
  });
});
