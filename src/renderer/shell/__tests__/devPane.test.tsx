// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceView } from '../../../shared/state';
import type { DevPaneActions } from '../components/DevPane';

vi.mock('../terminals', () => ({ ensureTerminal: vi.fn(), showTerminal: vi.fn(), fitTerminal: vi.fn(), terminalData: vi.fn(), disposeTerminal: vi.fn() }));

const { DevPane } = await import('../components/DevPane');
const { TabBar } = await import('../components/TabBar');
const { StartPage } = await import('../components/StartPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function ws(id: string, over: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id,
    name: `P ${id}`,
    projectPath: `/Users/x/${id}`,
    color: '#123',
    initial: 'P',
    iconUrl: null,
    claudeSessionId: null,
    model: 'opus',
    effort: null,
    splitRatio: 0.6,
    viewMode: 'split',
    attention: 'none',
    chatgpt: { loggedIn: true },
    task: null,
    latestReview: null,
    terminal: { running: true, error: null },
    ...over,
  };
}

const DIAG_LABELS = ['Page state', 'Capture Claude Prompt', 'Latest user msg', 'Mic status', 'Home', 'Insert into composer', 'Submit'];

const actions = () => ({
  cancelTask: vi.fn(),
  resetSession: vi.fn(),
  retryReview: vi.fn(),
  restartTerminal: vi.fn(),
  setModel: vi.fn(),
  setEffort: vi.fn(),
  clearTerminal: vi.fn(),
  responseInfo: vi.fn(async () => ({ available: true, blocks: [] })),
  copyResponse: vi.fn<DevPaneActions['copyResponse']>(async () => ({ ok: true })),
});
const diag = { state: vi.fn(), capture: vi.fn(), latestUser: vi.fn(), micStatus: vi.fn(), home: vi.fn(), submit: vi.fn(), insert: vi.fn() };

describe('development pane UI', () => {
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

  const render = (list: WorkspaceView[], activeId: string, debugMode = false, a = actions()) => {
    act(() => root.render(<DevPane workspaces={list} active={list.find((w) => w.id === activeId)!} debugMode={debugMode} actions={a} diagnostics={diag} />));
    return a;
  };
  const buttonLabels = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent?.trim());

  it('shows the active model and switches to another one', () => {
    const a = render([ws('a', { model: 'opus' })], 'a');
    const btn = (name: string) => Array.from(host.querySelectorAll('.model-seg button')).find((b) => b.textContent === name) as HTMLButtonElement;
    expect(btn('Opus').classList.contains('on')).toBe(true);
    expect(btn('Sonnet').classList.contains('on')).toBe(false);
    act(() => btn('Fable').click());
    expect(a.setModel).toHaveBeenCalledWith('a', 'fable');
    act(() => btn('Opus').click());
    expect(a.setModel).toHaveBeenCalledTimes(1);
  });

  it('shows the effort level right of the model and changes it', () => {
    const a = render([ws('a', { effort: 'high' })], 'a');
    const select = host.querySelector('.model-seg + select.effort-select') as HTMLSelectElement;
    expect(select.value).toBe('high');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    const change = (v: string) =>
      act(() => {
        select.value = v;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    change('max');
    expect(a.setEffort).toHaveBeenCalledWith('a', 'max');
    change('');
    expect(a.setEffort).toHaveBeenLastCalledWith('a', null);
  });

  it('while a task runs only STOP reflects it: model, effort and Copy stay usable', () => {
    const a = render([ws('a', { task: { status: 'running' } as WorkspaceView['task'] })], 'a');
    expect(buttonLabels()).toContain('Stop');
    expect((host.querySelector('select.effort-select') as HTMLSelectElement).disabled).toBe(false);
    const byText = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t) as HTMLButtonElement;
    expect(byText('Sonnet').disabled).toBe(false);
    act(() => byText('Sonnet').click());
    expect(a.setModel).toHaveBeenCalledWith('a', 'sonnet'); // applied to the next turn by the main process
    expect(byText('Copy').disabled).toBe(false);
  });

  it('STOP is not shown once the task is no longer active', () => {
    for (const status of ['review_pending', 'succeeded', 'cancelled', 'failed'] as const) {
      render([ws('a', { task: { status } as WorkspaceView['task'] })], 'a');
      expect(buttonLabels()).not.toContain('Stop');
    }
  });

  it('Clear runs /clear for the active Workspace, but not while a task runs (it would be queued into that turn)', () => {
    const a = render([ws('a')], 'a');
    const clear = () => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Clear') as HTMLButtonElement;
    act(() => clear().click());
    expect(a.clearTerminal).toHaveBeenCalledWith('a');
    render([ws('a', { task: { status: 'running' } as WorkspaceView['task'] })], 'a');
    expect(clear().disabled).toBe(true);
  });

  it('Copy copies the last response through the app (never /copy in the terminal), even while a task runs', () => {
    const a = render([ws('a', { task: { status: 'running' } as WorkspaceView['task'] })], 'a');
    act(() => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Copy') as HTMLButtonElement).click());
    expect(a.copyResponse).toHaveBeenCalledWith('a', 'auto');
    expect(a).not.toHaveProperty('copyTerminal');
  });

  it('several code blocks open a selection menu; picking one copies that block, "Full response" copies all', async () => {
    const a = render([ws('a')], 'a');
    a.copyResponse.mockResolvedValueOnce({ ok: false, blocks: [{ language: 'bash', preview: 'ls' }, { language: null, preview: 'x' }] });
    await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Copy') as HTMLButtonElement).click());
    expect(buttonLabels()).toEqual(expect.arrayContaining(['Code block 1 — bash', 'Code block 2', 'Full response']));
    await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Code block 2') as HTMLButtonElement).click());
    expect(a.copyResponse).toHaveBeenLastCalledWith('a', { block: 1 });
    expect(buttonLabels()).not.toContain('Full response');
  });

  it('the ▾ option copies the full response when there is a single block', async () => {
    const a = render([ws('a')], 'a');
    await act(async () => (host.querySelector('button[aria-label="More copy options"]') as HTMLButtonElement).click());
    await act(async () => (Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Copy full response') as HTMLButtonElement).click());
    expect(a.copyResponse).toHaveBeenLastCalledWith('a', 'full');
  });

  it('debug controls are hidden in normal mode', () => {
    render([ws('a')], 'a', false);
    for (const l of DIAG_LABELS) expect(buttonLabels()).not.toContain(l);
    expect(host.querySelector('[data-testid="diagnostics"]')).toBeNull();
    expect(buttonLabels()).not.toContain('Diagnostics');
  });

  it('debug controls are reachable only when Developer → Diagnostics is on', () => {
    render([ws('a')], 'a', true);
    const tab = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Diagnostics')!;
    act(() => tab.click());
    expect(host.querySelector('[data-testid="diagnostics"]')).not.toBeNull();
    expect(buttonLabels()).toContain('Page state');
  });

  it('the terminal is the pane (no preview dialog)', () => {
    render([ws('a')], 'a');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(buttonLabels().some((l) => l?.startsWith('Run in Claude'))).toBe(false);
    expect((host.querySelector('.terminal-wrap') as HTMLElement).style.display).toBe('flex');
    expect(buttonLabels()).not.toContain('Claude');
  });

  it('shows no review bar in the pane (review handback lives on the relay button)', () => {
    const task = {
      id: 't1',
      status: 'review_pending' as const,
      outcome: 'succeeded' as const,
      prompt: 'p',
      createdAt: '',
      error: null,
      review: { status: 'pending' as const, lastError: null, body: 'packet' },
    };
    const a = render([ws('a', { task })], 'a');
    expect(a.retryReview).not.toHaveBeenCalled();
    expect(host.querySelector('.review-bar')).toBeNull();
    expect(buttonLabels()).not.toContain('Send to ChatGPT for review');
    expect(buttonLabels()).not.toContain('Not now');
  });
});

describe('view buttons in the tab bar', () => {
  const render = (viewMode: Parameters<typeof TabBar>[0]['viewMode'], onViewMode = vi.fn()) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<TabBar workspaces={[ws('a')]} activeId="a" onSelect={vi.fn()} onReorder={vi.fn()} onContextMenu={vi.fn()} onNew={vi.fn()} onClose={vi.fn()} startOpen={false} onSelectStart={vi.fn()} onCloseStart={vi.fn()} viewMode={viewMode} onViewMode={onViewMode} />));
    return { host, onViewMode };
  };

  it('shows exactly three buttons with tooltips, marks only the current view and reports clicks', () => {
    const { host, onViewMode } = render('split');
    const btns = Array.from(host.querySelectorAll<HTMLButtonElement>('.layout-btn'));
    expect(btns.map((b) => b.title)).toEqual(['ChatGPT Focus', 'Split View', 'Claude Focus']);
    expect(btns.map((b) => b.classList.contains('selected'))).toEqual([false, true, false]);
    act(() => btns[2]!.click());
    expect(onViewMode).toHaveBeenCalledWith('claude-focus');
    act(() => btns[0]!.click());
    expect(onViewMode).toHaveBeenCalledWith('chatgpt-focus');
  });

  it('has no preset, Grid or Overview controls, and renders nothing without an active Workspace', () => {
    const { host } = render('chatgpt-focus');
    const labels = Array.from(host.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(labels.some((l) => /GPT \d|Terminal only|GPT only|Grid|Overview/.test(l))).toBe(false);
    expect(render(null).host.querySelector('.layout-presets')).toBeNull();
  });
});

describe('workspace tabs', () => {
  it('shows the custom icon image instead of the color dot, and opens the context menu on right-click', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onContextMenu = vi.fn();
    const onClose = vi.fn();
    const list = [ws('a', { iconUrl: 'data:image/png;base64,AAAA' }), ws('b')];
    act(() => root.render(<TabBar workspaces={list} activeId="a" onSelect={vi.fn()} onReorder={vi.fn()} onContextMenu={onContextMenu} onNew={vi.fn()} onClose={onClose} startOpen={false} onSelectStart={vi.fn()} onCloseStart={vi.fn()} viewMode={null} onViewMode={vi.fn()} />));
    const [a, b] = Array.from(host.querySelectorAll('.tab'));
    expect(a!.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(a!.querySelector('.tab-dot')).toBeNull();
    expect(a!.classList.contains('active')).toBe(true);
    expect(b!.querySelector('.tab-name')?.textContent).toBe('P b');
    act(() => {
      b!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(onContextMenu).toHaveBeenCalledWith('b');
    act(() => (b!.querySelector('.tab-close') as HTMLElement).click());
    expect(onClose).toHaveBeenCalledWith('b');
    act(() => root.unmount());
    host.remove();
  });
});

describe('Projects start page', () => {
  const mount = (projects: { id: string; name: string; projectPath: string; open: boolean }[]) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const h = { onCreate: vi.fn(), onOpen: vi.fn(), onContextMenu: vi.fn() };
    act(() => root.render(<StartPage projects={projects} {...h} />));
    return { host, root, ...h };
  };
  const list = [
    { id: 'a', name: 'AcmeShop', projectPath: '/Users/x/Documents/Projects/AcmeShop', open: true },
    { id: 'b', name: 'RideShare', projectPath: '/Users/x/Documents/Projects/RideShare', open: false },
  ];

  it('lists projects with bold name and directory, filters by name, opens on click and offers the context menu', () => {
    const { host, root, onOpen, onContextMenu, onCreate } = mount(list);
    expect(host.querySelector('h1')?.textContent).toBe('Projects');
    const rows = () => Array.from(host.querySelectorAll('.start-row'));
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.querySelector('b')?.textContent).toBe('AcmeShop');
    expect(rows()[0]!.querySelector('.start-path')?.textContent).toContain('Projects/AcmeShop');
    const input = host.querySelector('input') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'RID');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows().map((r) => r.querySelector('b')?.textContent)).toEqual(['RideShare']);
    act(() => (rows()[0] as HTMLElement).click());
    expect(onOpen).toHaveBeenCalledWith('b');
    act(() => {
      rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(onContextMenu).toHaveBeenCalledWith('b');
    act(() => (Array.from(host.querySelectorAll('button')).find((x) => x.textContent?.includes('Create')) as HTMLElement).click());
    expect(onCreate).toHaveBeenCalled();
    act(() => root.unmount());
    host.remove();
  });
});
