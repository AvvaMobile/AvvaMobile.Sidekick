import { session, shell, WebContentsView, type Session, type WebContents, type WebPreferences } from 'electron';
import { CHATGPT_PARTITION, isAllowedTopLevelUrl, isAuthUrl, isSafeExternalUrl } from './origins';
import { decidePermissionCheck, decidePermissionRequest } from './permissions';

/**
 * Hardened webPreferences for remote ChatGPT content (docs/SECURITY.md §2).
 * No preload: remote content gets no bridge of any kind.
 */
export function remoteWebPreferences(): WebPreferences {
  return {
    partition: CHATGPT_PARTITION,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: true,
  };
}

export interface PermissionLogEntry {
  at: string;
  kind: 'request' | 'check';
  permission: string;
  origin: string;
  mediaTypes?: readonly string[];
  allowed: boolean;
  reason: string;
}

export interface RemoteSessionHooks {
  onPermission?(entry: PermissionLogEntry): void;
}

const configured = new WeakSet<Session>();

/**
 * Removes the "Electron/x" and app tokens from the UA so identity providers see the
 * same UA string the embedded Chromium version would send. This does not change any
 * security behaviour (docs/ARCHITECTURE.md §6).
 */
export function chromeLikeUserAgent(ua: string): string {
  return ua
    .replace(/\s*Electron\/\S+/g, '')
    // App name token(s) Electron inserts between "(KHTML, like Gecko)" and "Chrome/" (any app name).
    .replace(/(\(KHTML, like Gecko\))\s+.*?\s*(Chrome\/)/, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Configure the shared ChatGPT session exactly once. */
function getChatGptSession(hooks: RemoteSessionHooks): Session {
  const ses = session.fromPartition(CHATGPT_PARTITION);
  if (configured.has(ses)) return ses;
  configured.add(ses);

  ses.setUserAgent(chromeLikeUserAgent(ses.getUserAgent()));

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const decision = decidePermissionRequest({
      permission,
      requestingUrl: details.requestingUrl ?? '',
      topLevelUrl: wc?.getURL() || undefined,
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
      isMainFrame: details.isMainFrame,
    });
    hooks.onPermission?.({
      at: new Date().toISOString(),
      kind: 'request',
      permission,
      origin: safeOrigin(details.requestingUrl ?? ''),
      mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
      allowed: decision.allow,
      reason: decision.reason,
    });
    callback(decision.allow);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return decidePermissionCheck({ permission, requestingOrigin, mediaType: 'mediaType' in details ? details.mediaType : undefined });
  });

  // USB/HID/serial/bluetooth device access is never needed.
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  ses.on('will-download', (event) => event.preventDefault());

  return ses;
}

function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return '<invalid>';
  }
}

export interface NavigationLogEntry {
  at: string;
  kind: 'navigate-allowed' | 'navigate-blocked' | 'popup-allowed' | 'popup-external' | 'popup-blocked';
  url: string;
}

/**
 * Applies navigation and window-open policy to a remote webContents.
 * - Top-level navigation outside the allowlist is blocked and offered to the OS browser.
 * - window.open to auth hosts opens a hardened child window in the same session (OAuth popups).
 * - Any other window.open is denied in-app and opened externally after validation.
 */
function applyNavigationPolicy(wc: WebContents, onLog?: (e: NavigationLogEntry) => void): void {
  const log = (kind: NavigationLogEntry['kind'], url: string) =>
    onLog?.({ at: new Date().toISOString(), kind, url: redactUrl(url) });
  // A page must not be able to spam the OS browser (these opens need no user gesture).
  const openExternal = rateLimited((url: string) => void shell.openExternal(url));

  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAllowedTopLevelUrl(url)) {
      log('navigate-allowed', url);
      return;
    }
    event.preventDefault();
    log('navigate-blocked', url);
    if (isSafeExternalUrl(url)) openExternal(url);
  };
  wc.on('will-navigate', (event) => guard(event, event.url));
  wc.on('will-redirect', (event) => {
    if (!event.isMainFrame) return;
    guard(event, event.url);
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());

  wc.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url) || isAllowedTopLevelUrl(url)) {
      // OAuth popups: hardened child window, same partition so the login lands in the shared session.
      if (isAuthUrl(url)) {
        log('popup-allowed', url);
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: remoteWebPreferences(),
          },
        };
      }
    }
    if (isSafeExternalUrl(url)) {
      log('popup-external', url);
      openExternal(url);
    } else {
      log('popup-blocked', url);
    }
    return { action: 'deny' };
  });

  wc.on('did-create-window', (child) => {
    applyNavigationPolicy(child.webContents, onLog);
  });
}

const EXTERNAL_OPEN_INTERVAL_MS = 2_000;

/** Wraps `fn` so it runs at most once per `intervalMs`; calls in between are dropped. */
export function rateLimited<A extends unknown[]>(fn: (...args: A) => void, intervalMs = EXTERNAL_OPEN_INTERVAL_MS, now: () => number = Date.now): (...args: A) => boolean {
  let last = -Infinity;
  return (...args: A) => {
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    fn(...args);
    return true;
  };
}

/** Replaces every http(s) URL in free text (e.g. an error message) by its origin and path. */
export function redactUrlsIn(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>()]+/g, (u) => redactUrl(u));
}

/** Strip query/fragment (they can carry OAuth codes/state) before logging. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid>';
  }
}

export function createChatGptView(hooks: RemoteSessionHooks, onNavLog?: (e: NavigationLogEntry) => void): WebContentsView {
  getChatGptSession(hooks);
  const view = new WebContentsView({ webPreferences: remoteWebPreferences() });
  applyNavigationPolicy(view.webContents, onNavLog);
  return view;
}
