import { isAbsolute } from 'node:path';
import { validateWorkspaceName } from '../../domain/workspace/workspace';
import { parseGithubRepository } from '../../shared/github';
import { isModelChoice } from '../../shared/models';
import type { AppSettingsPatch, ProjectSettingsPatch } from '../../shared/settings';
import { conversationUrlToStore, isChatGptConversationUrl } from '../security/origins';

export type Validated<T> = { ok: true; patch: T } | { ok: false; detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PROJECT_KEYS = ['name', 'projectPath', 'color', 'model', 'chatConversationUrl', 'icon', 'githubRepository'] as const;
const APP_KEYS = ['developerMode'] as const;

/**
 * Strict validation of a `workspace:update-settings` patch from the renderer. Pure except for `isDirectory`
 * (injected so the folder check is testable). Normalizes the name and lower-cases the color.
 */
export function validateProjectSettingsPatch(raw: unknown, isDirectory: (path: string) => boolean): Validated<ProjectSettingsPatch> {
  if (!isRecord(raw)) return { ok: false, detail: 'Invalid settings.' };
  const keys = Object.keys(raw);
  if (keys.length === 0) return { ok: false, detail: 'Nothing to change.' };
  const unknown = keys.find((k) => !(PROJECT_KEYS as readonly string[]).includes(k));
  if (unknown) return { ok: false, detail: `Unknown setting: ${unknown.slice(0, 40)}` };

  const patch: ProjectSettingsPatch = {};
  if ('name' in raw) {
    const n = validateWorkspaceName(raw.name);
    if (!n) return { ok: false, detail: 'Project name is required (max 60 characters).' };
    patch.name = n;
  }
  if ('projectPath' in raw) {
    const p = raw.projectPath;
    if (typeof p !== 'string' || p.length > 4096 || !isAbsolute(p) || !isDirectory(p)) return { ok: false, detail: 'Choose an existing local folder.' };
    patch.projectPath = p;
  }
  if ('color' in raw) {
    if (typeof raw.color !== 'string' || !HEX_COLOR.test(raw.color)) return { ok: false, detail: 'Color must be a #rrggbb value.' };
    patch.color = raw.color.toLowerCase();
  }
  if ('model' in raw) {
    if (raw.model !== null && !isModelChoice(raw.model)) return { ok: false, detail: 'Unknown model.' };
    patch.model = raw.model;
  }
  if ('chatConversationUrl' in raw) {
    const u = raw.chatConversationUrl;
    if (u !== null && (typeof u !== 'string' || u.length > 2048 || !isChatGptConversationUrl(u)))
      return { ok: false, detail: 'Enter a ChatGPT conversation link (https://chatgpt.com/c/…).' };
    patch.chatConversationUrl = u === null ? null : conversationUrlToStore(u);
  }
  if ('icon' in raw) {
    if (raw.icon !== null) return { ok: false, detail: 'Choose an icon with “Choose Image…”.' };
    patch.icon = null;
  }
  if ('githubRepository' in raw) {
    const r = raw.githubRepository;
    if (r === null || r === '') patch.githubRepository = null;
    else {
      const repo = parseGithubRepository(r);
      if (!repo) return { ok: false, detail: 'Enter a GitHub repository as owner/repo.' };
      patch.githubRepository = repo;
    }
  }
  return { ok: true, patch };
}

/** Strict validation of an `app:update-settings` patch. */
export function validateAppSettingsPatch(raw: unknown): Validated<AppSettingsPatch> {
  if (!isRecord(raw)) return { ok: false, detail: 'Invalid settings.' };
  const keys = Object.keys(raw);
  if (keys.length === 0) return { ok: false, detail: 'Nothing to change.' };
  const unknown = keys.find((k) => !(APP_KEYS as readonly string[]).includes(k));
  if (unknown) return { ok: false, detail: `Unknown setting: ${unknown.slice(0, 40)}` };
  const patch: AppSettingsPatch = {};
  for (const k of APP_KEYS) {
    if (!(k in raw)) continue;
    if (typeof raw[k] !== 'boolean') return { ok: false, detail: `${k} must be true or false.` };
    patch[k] = raw[k];
  }
  return { ok: true, patch };
}
