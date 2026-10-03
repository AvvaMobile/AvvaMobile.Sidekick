/** Which part of Claude's last response the Copy action puts on the clipboard. */
export type CopyTarget = 'auto' | 'full' | { block: number };

/** One fenced code block of the last response, as listed in the Copy menu. */
export interface BlockInfo {
  language: string | null;
  /** First non-empty line of the code, for telling blocks apart. */
  preview: string;
}

export type CopyKind = 'code' | 'response';
