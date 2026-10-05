import { useRef, useState } from 'react';
import { PRESET_MODES, type LayoutMode } from '../../../domain/layout/splitPane';
import type { WorkspaceView } from '../../../shared/state';

const PRESET_TITLES: Record<(typeof PRESET_MODES)[number], string> = {
  'gpt-hidden': 'Terminal only',
  'split-20-80': 'GPT 20 / Terminal 80',
  'split-50-50': 'GPT 50 / Terminal 50',
  'split-80-20': 'GPT 80 / Terminal 20',
  'terminal-hidden': 'GPT only',
};

/** Left-pane share drawn in the icon (ChatGPT left, terminal right). */
const ICON_SPLIT: Record<(typeof PRESET_MODES)[number], number> = { 'gpt-hidden': 0, 'split-20-80': 0.2, 'split-50-50': 0.5, 'split-80-20': 0.8, 'terminal-hidden': 1 };

function LayoutIcon({ mode }: { mode: (typeof PRESET_MODES)[number] }) {
  // A tiny window: the two panes fill it edge to edge (no inner padding).
  const body = 16;
  const left = Math.round(body * ICON_SPLIT[mode]);
  const clip = `layout-icon-${mode}`;
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true">
      <clipPath id={clip}>
        <rect x="0.5" y="0.5" width="17" height="13" rx="2" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        {left > 0 && <rect x="1" y="1" width={left} height="12" fill="#f7f7f8" />}
        {left < body && <rect x={1 + left} y="1" width={body - left} height="12" fill="currentColor" />}
      </g>
      <rect x="0.5" y="0.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" opacity=".6" />
    </svg>
  );
}

interface Props {
  workspaces: WorkspaceView[];
  activeId: string | null;
  onSelect(id: string): void;
  /** Called with the full new order after a drag-and-drop move. */
  onReorder(ids: string[]): void;
  /** Right-click: per-Workspace menu (change icon, …). */
  onContextMenu(id: string): void;
  /** `+`: opens the Projects start page. */
  onNew(): void;
  /** Close a Workspace's tab (the saved Workspace stays). */
  onClose(id: string): void;
  /** The Projects start page has a tab of its own while it is open. */
  startOpen: boolean;
  onSelectStart(): void;
  onCloseStart(): void;
  /** Layout of the active Workspace; null hides the preset buttons (start page, settings). */
  layoutMode: LayoutMode | null;
  onLayout(mode: LayoutMode): void;
}

function stateOf(ws: WorkspaceView): { cls: string; title: string } {
  const st = ws.task?.status;
  if (st === 'running' || st === 'queued') return { cls: 'running', title: 'Claude running' };
  if (ws.attention === 'failed') return { cls: 'failed', title: 'Claude task failed' };
  if (ws.attention === 'completed') return { cls: 'completed', title: 'Claude finished' };
  return { cls: '', title: '' };
}

/** Pointer travel before a press becomes a drag (a shorter press is a click). */
const DRAG_THRESHOLD = 4;
const DROP_MS = 150;

interface Drag {
  id: string;
  from: number;
  startX: number;
  dx: number;
  /** Distance between two tab slots (tab width + gap), measured at drag start. */
  slot: number;
  active: boolean;
  dropping: boolean;
}

/** Index the dragged tab would land on for a horizontal offset. */
export function targetIndex(from: number, dx: number, slot: number, count: number): number {
  return Math.max(0, Math.min(count - 1, from + Math.round(dx / slot)));
}

/** Offset for a non-dragged tab at `index` while the dragged one moves from `from` to `to`. */
export function shiftFor(index: number, from: number, to: number, slot: number): number {
  if (from < to && index > from && index <= to) return -slot;
  if (from > to && index >= to && index < from) return slot;
  return 0;
}

/**
 * Browser-style project tab strip (replaces the Slack-style sidebar, D016). Tabs are reordered by
 * dragging: the other tabs slide out of the way (animated), the dragged tab settles on release.
 */
export function TabBar({ workspaces, activeId, onSelect, onReorder, onContextMenu, onNew, onClose, startOpen, onSelectStart, onCloseStart, layoutMode, onLayout }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const update = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const to = drag ? targetIndex(drag.from, drag.dx, drag.slot, workspaces.length) : -1;

  const onPointerDown = (e: React.PointerEvent<HTMLElement>, id: string, index: number) => {
    if (e.button !== 0 || dragRef.current) return;
    const list = e.currentTarget.parentElement!;
    const items = list.querySelectorAll<HTMLElement>('.tab:not(.start)');
    const slot = items.length > 1 ? items[1]!.offsetLeft - items[0]!.offsetLeft : e.currentTarget.offsetWidth + 4;
    e.currentTarget.setPointerCapture(e.pointerId);
    update({ id, from: index, startX: e.clientX, dx: 0, slot, active: false, dropping: false });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.dropping) return;
    const dx = e.clientX - d.startX;
    if (!d.active && Math.abs(dx) < DRAG_THRESHOLD) return;
    update({ ...d, dx, active: true });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>, id: string) => {
    const d = dragRef.current;
    if (!d || d.dropping) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d.active) {
      update(null);
      onSelect(id);
      return;
    }
    const dest = targetIndex(d.from, d.dx, d.slot, workspaces.length);
    // Glide the dragged tab into its final slot, then commit the new order.
    update({ ...d, dx: (dest - d.from) * d.slot, dropping: true });
    window.setTimeout(() => {
      if (dest !== d.from) {
        const ids = workspaces.map((w) => w.id).filter((x) => x !== d.id);
        ids.splice(dest, 0, d.id);
        onReorder(ids);
      }
      update(null);
    }, DROP_MS);
  };

  return (
    <header className="topbar">
      <nav className="tabs" aria-label="Workspaces" role="tablist">
        <div className={`tab-list ${drag?.active ? 'reordering' : ''}`}>
          {workspaces.map((ws, index) => {
            const s = stateOf(ws);
            const active = ws.id === activeId;
            const isDragged = drag?.active && drag.id === ws.id;
            let transform = '';
            if (drag?.active) transform = isDragged ? `translateX(${drag.dx}px) scale(${drag.dropping ? 1 : 1.03})` : `translateX(${shiftFor(index, drag.from, to, drag.slot)}px)`;
            return (
              <div
                key={ws.id}
                role="tab"
                tabIndex={0}
                className={`tab ${active ? 'active' : ''} ${s.cls} ${isDragged ? 'dragging' : ''} ${isDragged && drag.dropping ? 'dropping' : ''}`}
                style={{ transform: transform || undefined }}
                title={s.title ? `${ws.name} — ${s.title}\n${ws.projectPath}` : `${ws.name}\n${ws.projectPath}`}
                aria-selected={active}
                onPointerDown={(e) => onPointerDown(e, ws.id, index)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => onPointerUp(e, ws.id)}
                onPointerCancel={() => update(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!dragRef.current?.active) onContextMenu(ws.id);
                }}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) onSelect(ws.id);
                }}
              >
                {ws.iconUrl ? <img className="tab-img" src={ws.iconUrl} alt="" draggable={false} /> : <span className="tab-dot" style={{ background: ws.color }} />}
                <span className="tab-name">{ws.name}</span>
                {s.cls && <span className={`tab-badge ${s.cls}`} aria-hidden="true" />}
                <button
                  className="tab-close"
                  aria-label={`Close ${ws.name}`}
                  title="Close tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(ws.id);
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" /></svg>
                </button>
              </div>
            );
          })}
          {startOpen && (
            <div className={`tab start ${activeId === null ? 'active' : ''}`} role="tab" tabIndex={0} aria-selected={activeId === null} onClick={onSelectStart}>
              <span className="tab-name">Projects</span>
              <button className="tab-close" aria-label="Close Projects" title="Close tab" onClick={(e) => { e.stopPropagation(); onCloseStart(); }}>
                <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" /></svg>
              </button>
            </div>
          )}
          <button className="tab-add" title={`New Workspace (${/Mac/i.test(navigator.platform) ? '⌘N' : 'Ctrl+N'})`} aria-label="New Workspace" onClick={onNew}>
            +
          </button>
        </div>
      </nav>
      {layoutMode && (
        <div className="layout-presets" role="group" aria-label="Pane layout">
          {PRESET_MODES.map((m) => (
            <button key={m} className={`layout-btn ${layoutMode === m ? 'selected' : ''}`} title={PRESET_TITLES[m]} aria-label={PRESET_TITLES[m]} aria-pressed={layoutMode === m} onClick={() => onLayout(m)}>
              <LayoutIcon mode={m} />
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
