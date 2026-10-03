import { describe, expect, it, vi } from 'vitest';
import { renameWithRetry } from '../renameWithRetry';

const busy = () => Object.assign(new Error('busy'), { code: 'EPERM' });

describe('renameWithRetry', () => {
  it('retries transient failures on Windows', () => {
    const rename = vi.fn().mockImplementationOnce(() => { throw busy(); }).mockImplementationOnce(() => {});
    renameWithRetry('a', 'b', 'win32', rename);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('does not retry elsewhere', () => {
    const rename = vi.fn(() => { throw busy(); });
    expect(() => renameWithRetry('a', 'b', 'darwin', rename)).toThrow('busy');
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
