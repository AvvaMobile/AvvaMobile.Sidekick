import { isChatGptAppOrigin, isChatGptAppUrl } from './origins';

/**
 * Pure permission policy for the ChatGPT session. Everything not explicitly allowed is denied.
 *
 * - Microphone (audio-only "media") is allowed only for the approved ChatGPT app origins' main frame
 *   (ChatGPT voice). Camera / screen capture are never granted.
 * - Sanitized clipboard writes are allowed for ChatGPT so its "Copy" buttons keep working.
 */

export interface PermissionRequestInput {
  permission: string;
  /** Origin/URL of the frame making the request. */
  requestingUrl: string;
  /** Top-level URL of the webContents, when known. */
  topLevelUrl?: string;
  /** Media types for "media" requests (Electron: details.mediaTypes). */
  mediaTypes?: readonly string[];
  /** Electron: details.isMainFrame. Media from cross-origin subframes is denied. */
  isMainFrame?: boolean;
}

export type PermissionDecision = { allow: true; reason: string } | { allow: false; reason: string };

export function decidePermissionRequest(input: PermissionRequestInput): PermissionDecision {
  const fromChatGpt = isChatGptAppUrl(input.requestingUrl) || isChatGptAppOrigin(input.requestingUrl);
  const topIsChatGpt = input.topLevelUrl === undefined || isChatGptAppUrl(input.topLevelUrl);

  switch (input.permission) {
    case 'media': {
      if (!fromChatGpt || !topIsChatGpt) return { allow: false, reason: 'media: origin not approved' };
      if (input.isMainFrame === false) return { allow: false, reason: 'media: subframe request' };
      const types = input.mediaTypes ?? [];
      if (types.length === 0) return { allow: false, reason: 'media: unspecified media type' };
      if (!types.every((t) => t === 'audio')) return { allow: false, reason: 'media: only audio is allowed' };
      return { allow: true, reason: 'media: microphone for approved ChatGPT origin' };
    }
    case 'clipboard-sanitized-write':
      return fromChatGpt && topIsChatGpt
        ? { allow: true, reason: 'clipboard write for ChatGPT copy button' }
        : { allow: false, reason: 'clipboard: origin not approved' };
    default:
      return { allow: false, reason: `${input.permission}: not allowlisted` };
  }
}

export interface PermissionCheckInput {
  permission: string;
  requestingOrigin: string;
  mediaType?: string;
}

/** Synchronous permission *checks* (navigator.permissions.query, enumerateDevices labels, ...). */
export function decidePermissionCheck(input: PermissionCheckInput): boolean {
  if (!isChatGptAppOrigin(input.requestingOrigin) && !isChatGptAppUrl(input.requestingOrigin)) return false;
  if (input.permission === 'media') {
    // Microphone only; 'unknown' or unspecified media types are denied.
    return input.mediaType === 'audio';
  }
  return input.permission === 'clipboard-sanitized-write';
}
