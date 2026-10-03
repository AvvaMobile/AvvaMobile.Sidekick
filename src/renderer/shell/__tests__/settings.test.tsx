// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings as AppSettingsData, ProjectSettings as ProjectSettingsData } from '../../../shared/settings';
import type { WorkspaceApi } from '../api';
import { AppSettings } from '../components/AppSettings';
import { ProjectSettings } from '../components/ProjectSettings';
import { StartPage } from '../components/StartPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = (over: Partial<ProjectSettingsData> = {}): ProjectSettingsData => ({
  id: 'p1',
  name: 'Alpha',
  projectPath: '/Users/x/alpha',
  color: '#1971c2',
  iconUrl: null,
  initial: 'A',
  model: null,
  defaultModel: 'opus',
  chatConversationUrl: 'https://chatgpt.com/c/abc',
  claudeSessionId: 'sess-1',
  taskActive: false,
  ...over,
});
const appData = (over: Partial<AppSettingsData> = {}): AppSettingsData => ({
  autoSendOnRequest: true,
  developerMode: false,
  defaultModel: 'sonnet',
  version: '0.1.0',
  userDataPath: '/Users/x/Library/Application Support/AvvaMobile.Sidekick',
  ...over,
});

function fakeApi(p = project(), a = appData()) {
  return {
    platform: 'darwin',
    getProjectSettings: vi.fn(async () => p),
    updateProjectSettings: vi.fn(async (_id: string, patch: object) => ({ ok: true as const, settings: { ...p, ...patch } })),
    chooseIcon: vi.fn(async () => ({ ok: false as const, code: 'cancelled' })),
    pickFolder: vi.fn(async () => ({ path: '/Users/x/beta', name: 'beta' })),
    resetSession: vi.fn(async () => ({ ok: true as const })),
    closeWorkspace: vi.fn(async () => ({ ok: true as const })),
    removeWorkspace: vi.fn(async () => ({ ok: false as const, code: 'cancelled' })),
    getAppSettings: vi.fn(async () => a),
    updateAppSettings: vi.fn(async (patch: object) => ({ ok: true as const, settings: { ...a, ...patch } })),
    revealUserData: vi.fn(async () => {}),
  };
}
const asApi = (f: ReturnType<typeof fakeApi>) => f as unknown as WorkspaceApi;

const flush = () => act(async () => {});
const button = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const setInput = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

describe('settings screens', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  describe('Project Settings', () => {
    const render = async (f = fakeApi(), onClose = vi.fn()) => {
      act(() => root.render(<ProjectSettings api={asApi(f)} workspaceId="p1" refreshKey={1} onClose={onClose} />));
      await flush();
      return { f, onClose };
    };

    it('renders every per-project setting', async () => {
      await render();
      expect(host.querySelector('h1')?.textContent).toBe('Alpha — Settings');
      expect((host.querySelector('input[aria-label="Project name"]') as HTMLInputElement).value).toBe('Alpha');
      expect(host.textContent).toContain('/Users/x/alpha');
      expect(host.textContent).toContain('sess-1');
      expect(button(host, 'App default (Opus)').getAttribute('aria-checked')).toBe('true');
      expect((host.querySelector('input[aria-label="ChatGPT conversation link"]') as HTMLInputElement).value).toBe('https://chatgpt.com/c/abc');
      for (const t of ['Choose Image…', 'Close Tab', 'Delete Project…', 'New Claude session', 'Reset to ChatGPT Home']) expect(button(host, t)).toBeTruthy();
    });

    it('saves a renamed project on Enter', async () => {
      const { f } = await render();
      const input = host.querySelector('input[aria-label="Project name"]') as HTMLInputElement;
      act(() => setInput(input, 'Beta'));
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await flush();
      expect(f.updateProjectSettings).toHaveBeenCalledWith('p1', { name: 'Beta' });
    });

    it('shows a validation error inline', async () => {
      const f = fakeApi();
      f.updateProjectSettings.mockResolvedValueOnce({ ok: false, detail: 'Project name is required (max 60 characters).' } as never);
      await render(f);
      const input = host.querySelector('input[aria-label="Project name"]') as HTMLInputElement;
      act(() => setInput(input, '   x'));
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await flush();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Project name is required');
    });

    it('changes model, color, folder and resets the conversation', async () => {
      const { f } = await render();
      act(() => button(host, 'Sonnet').click());
      await flush();
      expect(f.updateProjectSettings).toHaveBeenCalledWith('p1', { model: 'sonnet' });
      act(() => (host.querySelector('button[aria-label="#2b8a3e"]') as HTMLButtonElement).click());
      await flush();
      expect(f.updateProjectSettings).toHaveBeenCalledWith('p1', { color: '#2b8a3e' });
      act(() => button(host, 'Change…').click());
      await flush();
      expect(f.updateProjectSettings).toHaveBeenCalledWith('p1', { projectPath: '/Users/x/beta' });
      act(() => button(host, 'Reset to ChatGPT Home').click());
      await flush();
      expect(f.updateProjectSettings).toHaveBeenCalledWith('p1', { chatConversationUrl: null });
    });

    it('reuses the existing session, close and delete actions', async () => {
      const { f } = await render();
      act(() => button(host, 'New Claude session').click());
      act(() => button(host, 'Close Tab').click());
      act(() => button(host, 'Delete Project…').click());
      await flush();
      expect(f.resetSession).toHaveBeenCalledWith('p1');
      expect(f.closeWorkspace).toHaveBeenCalledWith('p1');
      expect(f.removeWorkspace).toHaveBeenCalledWith('p1');
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it('Esc and Back close the screen', async () => {
      const { onClose } = await render();
      act(() => esc());
      expect(onClose).toHaveBeenCalledTimes(1);
      act(() => (host.querySelector('button[aria-label="Close settings"]') as HTMLButtonElement).click());
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('App Settings', () => {
    const render = async (f = fakeApi(), onClose = vi.fn()) => {
      act(() => root.render(<AppSettings api={asApi(f)} refreshKey={1} onClose={onClose} />));
      await flush();
      return { f, onClose };
    };

    it('renders preferences, the read-only default model and About', async () => {
      await render();
      expect((host.querySelector('input[aria-label="Auto-send when I ask ChatGPT"]') as HTMLInputElement).checked).toBe(true);
      expect((host.querySelector('input[aria-label="Developer mode"]') as HTMLInputElement).checked).toBe(false);
      expect(host.textContent).toContain('Sonnet');
      expect(host.textContent).toContain('0.1.0');
      expect(host.textContent).toContain('/Users/x/Library/Application Support/AvvaMobile.Sidekick');
      expect(button(host, 'Reveal in Finder')).toBeTruthy();
    });

    it('toggles save immediately', async () => {
      const { f } = await render();
      act(() => (host.querySelector('input[aria-label="Developer mode"]') as HTMLInputElement).click());
      await flush();
      expect(f.updateAppSettings).toHaveBeenCalledWith({ developerMode: true });
      expect((host.querySelector('input[aria-label="Developer mode"]') as HTMLInputElement).checked).toBe(true);
      act(() => (host.querySelector('input[aria-label="Auto-send when I ask ChatGPT"]') as HTMLInputElement).click());
      await flush();
      expect(f.updateAppSettings).toHaveBeenCalledWith({ autoSendOnRequest: false });
      act(() => button(host, 'Reveal in Finder').click());
      expect(f.revealUserData).toHaveBeenCalled();
    });

    it('Esc closes', async () => {
      const { onClose } = await render();
      act(() => esc());
      expect(onClose).toHaveBeenCalled();
    });

    it('the Projects page gear opens it', () => {
      const onSettings = vi.fn();
      act(() => root.render(<StartPage projects={[]} onCreate={vi.fn()} onOpen={vi.fn()} onContextMenu={vi.fn()} onSettings={onSettings} />));
      act(() => (host.querySelector('button[aria-label="App settings"]') as HTMLButtonElement).click());
      expect(onSettings).toHaveBeenCalled();
    });
  });
});
