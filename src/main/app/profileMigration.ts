import { existsSync, renameSync } from 'node:fs';

/**
 * Moves the pre-rename profile folder to its new location once (D035): only when the new folder does not
 * exist yet and the old one does. Never throws; on failure the app simply starts with a fresh profile
 * and the old folder is left untouched.
 */
export function migrateLegacyProfile(legacyDir: string, profileDir: string, fs = { existsSync, renameSync }): 'moved' | 'skipped' | 'failed' {
  try {
    if (fs.existsSync(profileDir) || !fs.existsSync(legacyDir)) return 'skipped';
    fs.renameSync(legacyDir, profileDir);
    return 'moved';
  } catch {
    return 'failed';
  }
}
