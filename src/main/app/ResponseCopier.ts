import { parseCodeBlocks } from '../../domain/response/codeBlocks';
import type { BlockInfo, CopyKind, CopyTarget } from '../../shared/response';
import { lastAssistantText, type StopEvent } from '../claude/StopHookChannel';

export type CopyOutcome =
  | { ok: true; kind: CopyKind }
  | { ok: false; code: 'empty'; detail: string }
  | { ok: false; code: 'choose'; blocks: BlockInfo[] }
  | { ok: false; code: 'invalid'; detail: string };

export interface ResponseInfo {
  available: boolean;
  blocks: BlockInfo[];
}

/**
 * Copy of Claude's last completed response (in memory, per Workspace). The text is the authoritative
 * final assistant message of the Stop hook (transcript fallback), never terminal output. Copying only
 * writes to the clipboard: it has no PTY, Claude or task dependency by construction.
 */
export class ResponseCopier {
  private readonly last = new Map<string, string>();

  constructor(
    private readonly clipboard: { writeText(text: string): void },
    private readonly readTranscript: (path: string) => string | null,
  ) {}

  /** Remembers the response that ended a Claude turn (the Stop hook of the user's or a managed run). */
  record(workspaceId: string, e: StopEvent): void {
    const text = e.lastAssistantMessage ?? (e.transcriptPath ? lastAssistantText(this.readTranscript(e.transcriptPath) ?? '') : null);
    if (text && text.trim()) this.last.set(workspaceId, text);
  }

  forget(workspaceId: string): void {
    this.last.delete(workspaceId);
  }

  info(workspaceId: string): ResponseInfo {
    const text = this.last.get(workspaceId);
    if (!text) return { available: false, blocks: [] };
    return {
      available: true,
      blocks: parseCodeBlocks(text).map((b) => ({ language: b.language, preview: b.body.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? '' })),
    };
  }

  copy(workspaceId: string, target: CopyTarget): CopyOutcome {
    const text = this.last.get(workspaceId);
    if (!text) return { ok: false, code: 'empty', detail: 'No Claude response to copy yet.' };
    const blocks = parseCodeBlocks(text);
    const write = (s: string, kind: CopyKind): CopyOutcome => {
      this.clipboard.writeText(s);
      return { ok: true, kind };
    };
    if (target === 'full') return write(text, 'response');
    if (typeof target === 'object') {
      const b = Number.isInteger(target.block) ? blocks[target.block] : undefined;
      return b ? write(b.body, 'code') : { ok: false, code: 'invalid', detail: 'That code block is no longer available.' };
    }
    if (blocks.length === 0) return write(text, 'response');
    if (blocks.length === 1) return write(blocks[0]!.body, 'code');
    return { ok: false, code: 'choose', blocks: this.info(workspaceId).blocks };
  }
}
