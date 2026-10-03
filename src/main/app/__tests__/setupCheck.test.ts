import { describe, expect, it, vi } from 'vitest';
import { checkTool, microphoneSettingsUrl, microphoneStatus } from '../setupCheck';

describe('setup check', () => {
  it('reports a missing executable without probing it', async () => {
    const probe = vi.fn();
    expect(await checkTool(null, {}, probe)).toEqual({ found: false, version: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports the version of a tool that runs', async () => {
    expect(await checkTool('/usr/bin/git', {}, async () => 'git version 2.50.1')).toEqual({ found: true, version: 'git version 2.50.1' });
  });

  it('treats an executable that fails to run as missing', async () => {
    expect(await checkTool('/x/claude', {}, async () => null)).toEqual({ found: false, version: null });
  });

  it('maps microphone status per platform', () => {
    expect(microphoneStatus('darwin', () => 'not-determined')).toBe('not-determined');
    expect(microphoneStatus('win32', () => 'granted')).toBe('granted');
    expect(microphoneStatus('darwin', () => 'weird')).toBe('unknown');
    expect(microphoneStatus('linux', () => 'granted')).toBe('not-needed');
    expect(microphoneSettingsUrl('darwin')).toContain('Privacy_Microphone');
    expect(microphoneSettingsUrl('linux')).toBeNull();
  });
});
