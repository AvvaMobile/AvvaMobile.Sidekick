import { renameSync } from 'node:fs';

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * `renameSync` for atomic saves. On Windows replacing a file fails transiently while another process
 * (antivirus, search indexer, backup) briefly holds it open; retry a few times before giving up.
 */
export function renameWithRetry(from: string, to: string, platform: NodeJS.Platform = process.platform, rename = renameSync): void {
  const attempts = platform === 'win32' ? 5 : 1;
  for (let i = 1; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || !code || !TRANSIENT.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * i);
    }
  }
}
