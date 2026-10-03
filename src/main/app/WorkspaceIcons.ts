import { nativeImage } from 'electron';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Longest side of a stored Workspace icon (sidebar shows 40pt; 2x for Retina plus headroom). */
const ICON_SIZE = 128;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
export const ICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'bmp', 'icns', 'svg'];

export type IconResult = { ok: true; file: string } | { ok: false; detail: string };

/**
 * Custom per-Workspace icons, stored uncropped as a PNG (longest side ≤ ICON_SIZE) in `<userData>/icons/<workspaceId>.png`.
 * The renderer receives them as small data URLs (no file:// access from the shell page).
 */
export class WorkspaceIcons {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly dir: string) {}

  importFrom(workspaceId: string, sourcePath: string): IconResult {
    try {
      if (!existsSync(sourcePath) || statSync(sourcePath).size > MAX_SOURCE_BYTES) return { ok: false, detail: 'Image not found or larger than 15 MB.' };
      const img = nativeImage.createFromPath(sourcePath);
      if (img.isEmpty()) return { ok: false, detail: 'This file could not be read as an image.' };
      const { width, height } = img.getSize();
      // Keep the whole image (no cropping); scale so the longest side is at most ICON_SIZE.
      const k = Math.min(1, ICON_SIZE / Math.max(width, height));
      const out = k < 1 ? img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'best' }) : img;
      mkdirSync(this.dir, { recursive: true });
      const file = `${workspaceId}.png`;
      writeFileSync(join(this.dir, file), out.toPNG());
      this.cache.set(workspaceId, `data:image/png;base64,${out.toPNG().toString('base64')}`);
      return { ok: true, file };
    } catch {
      return { ok: false, detail: 'The image could not be imported.' };
    }
  }

  /** Data URL for a Workspace's stored icon file, or null. */
  dataUrl(workspaceId: string, file: string | null | undefined): string | null {
    if (!file) return null;
    if (this.cache.has(workspaceId)) return this.cache.get(workspaceId)!;
    const img = nativeImage.createFromPath(join(this.dir, file));
    const url = img.isEmpty() ? null : `data:image/png;base64,${img.toPNG().toString('base64')}`;
    this.cache.set(workspaceId, url);
    return url;
  }

  remove(workspaceId: string, file: string | null | undefined): void {
    this.cache.delete(workspaceId);
    if (file) rmSync(join(this.dir, file), { force: true });
  }
}
