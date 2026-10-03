import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyProfile } from '../profileMigration';

describe('profile migration (D035)', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'sidekick-profile-'));

  it('moves the old folder when the new one does not exist', () => {
    const r = root();
    mkdirSync(join(r, 'Workspace'));
    writeFileSync(join(r, 'Workspace', 'workspace-state.json'), '{"x":1}');
    expect(migrateLegacyProfile(join(r, 'Workspace'), join(r, 'AvvaMobile.Sidekick'))).toBe('moved');
    expect(existsSync(join(r, 'Workspace'))).toBe(false);
    expect(readFileSync(join(r, 'AvvaMobile.Sidekick', 'workspace-state.json'), 'utf8')).toBe('{"x":1}');
  });

  it('never touches an existing new profile', () => {
    const r = root();
    mkdirSync(join(r, 'Workspace'));
    mkdirSync(join(r, 'AvvaMobile.Sidekick'));
    expect(migrateLegacyProfile(join(r, 'Workspace'), join(r, 'AvvaMobile.Sidekick'))).toBe('skipped');
    expect(existsSync(join(r, 'Workspace'))).toBe(true);
  });

  it('does nothing without an old folder, and reports failures instead of throwing', () => {
    const r = root();
    expect(migrateLegacyProfile(join(r, 'Workspace'), join(r, 'AvvaMobile.Sidekick'))).toBe('skipped');
    const failing = { existsSync: (p: string) => p.endsWith('Workspace'), renameSync: () => { throw new Error('EPERM'); } };
    expect(migrateLegacyProfile('/a/Workspace', '/a/AvvaMobile.Sidekick', failing as never)).toBe('failed');
  });
});
