// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SetupDialog } from '../components/SetupDialog';
import type { SetupCheck } from '../../../shared/setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHECK: SetupCheck = {
  claude: { found: true, version: '2.1.0 (Claude Code)' },
  git: { found: false, version: null },
  microphone: 'not-determined',
};

function render(chatgptLoggedIn: boolean | null = null) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const api = {
    checkSetup: vi.fn(async () => CHECK),
    openSetupLink: vi.fn(async () => {}),
    requestMicrophone: vi.fn(async () => 'granted' as const),
  };
  const onClose = vi.fn();
  act(() => root.render(<SetupDialog api={api} chatgptLoggedIn={chatgptLoggedIn} onClose={onClose} />));
  const btn = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label);
  const row = (title: string) => Array.from(host.querySelectorAll('.setup-row')).find((r) => r.querySelector('b')?.textContent === title)!;
  const cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, api, onClose, btn, row, cleanup };
}

describe('setup popup', () => {
  it('checks Claude Code and Git when it opens and links downloads', async () => {
    const { api, btn, row, cleanup } = render(true);
    await act(async () => {});
    expect(api.checkSetup).toHaveBeenCalledTimes(1);
    expect(row('Claude Code').querySelector('.setup-status')?.className).toContain('ok');
    expect(row('Claude Code').textContent).toContain('2.1.0');
    expect(row('Git').querySelector('.setup-status')?.className).toContain('missing');
    expect(row('ChatGPT account').querySelector('.setup-status')?.className).toContain('ok');
    act(() => (row('Git').querySelector('button') as HTMLButtonElement).click());
    expect(api.openSetupLink).toHaveBeenCalledWith('git');
    await act(async () => btn('Check again')!.click());
    expect(api.checkSetup).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('asks for the microphone only when the user clicks Allow', async () => {
    const { api, btn, row, cleanup } = render();
    await act(async () => {});
    expect(api.requestMicrophone).not.toHaveBeenCalled();
    await act(async () => btn('Allow')!.click());
    expect(api.requestMicrophone).toHaveBeenCalledTimes(1);
    expect(row('Microphone').querySelector('.setup-status')?.className).toContain('ok');
    expect(btn('Allow')).toBeUndefined();
    cleanup();
  });

  it('closes on Done', async () => {
    const { btn, onClose, cleanup } = render();
    await act(async () => {});
    act(() => btn('Done')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
