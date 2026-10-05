import type { EffortChoice, ModelChoice } from '../../shared/models';
import type { FlowEntry } from '../../shared/state';
import type { LayoutMode } from '../layout/splitPane';

export interface WorkspaceRecord {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  sidebarColor: string;
  sidebarOrder: number;
  chatConversationUrl: string | null;
  claudeSessionId: string | null;
  /** Older state files may also carry a `devPaneMode` here; it is ignored. */
  uiState: { splitRatio: number; /** Absent in records saved before presets: treated as 'custom'. */ layoutMode?: LayoutMode };
  lastTaskId: string | null;
  /** Custom icon image (file name under `<userData>/icons`), or none for the colored initial. */
  iconFile?: string | null;
  /** Has a tab (runtime). `false` after the tab was closed; the record stays so it can be reopened. Missing = open. */
  open?: boolean;
  /** Model chosen for the terminal's Claude Code; none = Claude Code's own default. */
  model?: ModelChoice | null;
  /** Effort level chosen for the terminal's Claude Code; none = Claude Code's own default. */
  effort?: EffortChoice | null;
  /** Recent ChatGPT <-> Claude flow steps, newest last ("where did I leave off?"). */
  flowLog?: FlowEntry[];
}

export const isOpen = (w: Pick<WorkspaceRecord, 'open'>): boolean => w.open !== false;

/** Dark-sidebar-friendly palette; a Workspace keeps its color for life. */
export const SIDEBAR_COLORS = ['#e8590c', '#2b8a3e', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#f08c00', '#5f3dc4', '#d6336c', '#2f9e44'];

export function colorForName(name: string, taken: readonly string[] = []): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const start = h % SIDEBAR_COLORS.length;
  for (let i = 0; i < SIDEBAR_COLORS.length; i++) {
    const c = SIDEBAR_COLORS[(start + i) % SIDEBAR_COLORS.length]!;
    if (!taken.includes(c)) return c;
  }
  return SIDEBAR_COLORS[start]!;
}

export function initialFor(name: string): string {
  const letters = name.trim().match(/\p{L}|\p{N}/u);
  return letters ? letters[0]!.toLocaleUpperCase('tr-TR') : '?';
}

export function validateWorkspaceName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  return n.length >= 1 && n.length <= 60 ? n : null;
}
