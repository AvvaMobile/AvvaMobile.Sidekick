/**
 * Single source of truth for every remote origin Sidekick trusts.
 *
 * Any change here must be reflected in origins.test.ts (docs/ARCHITECTURE.md §21).
 */

/** Origins that host the ChatGPT application itself. Adapter operations and microphone access are limited to these. */
export const CHATGPT_APP_HOSTS: readonly string[] = ['chatgpt.com', 'chat.openai.com'];

/** OpenAI-operated authentication hosts used by the ChatGPT login flow. */
export const OPENAI_AUTH_HOSTS: readonly string[] = ['auth.openai.com', 'auth0.openai.com'];

/**
 * Third-party identity providers that ChatGPT offers as "Continue with ..." options.
 * They are allowed as top-level navigations / auth popups only; they never get microphone access
 * and adapter operations refuse to run on them.
 */
export const IDENTITY_PROVIDER_HOSTS: readonly string[] = [
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  // Google's post-sign-in cookie sync redirect (CheckCookie -> accounts.youtube.com/accounts/SetSID -> back).
  'accounts.youtube.com',
];

/**
 * Google also syncs the sign-in to its regional account hosts (accounts.google.com.tr, accounts.google.de, …)
 * during the same redirect chain. Exact `accounts.google.<tld>` / `accounts.google.co(m).<cc>` only.
 */
const GOOGLE_REGIONAL_ACCOUNTS_HOST = /^accounts\.google\.(?:co\.|com\.)?[a-z]{2,3}$/;

/** Chromium session partition that holds the ChatGPT login (cookies, storage). Shared by all Workspaces. */
export const CHATGPT_PARTITION = 'persist:chatgpt';

export const CHATGPT_HOME_URL = 'https://chatgpt.com/';

function parseHttps(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // Credentials in URLs and non-default ports are never part of legitimate flows.
  if (url.username || url.password || url.port) return null;
  return url;
}

function hostIn(host: string, list: readonly string[]): boolean {
  return list.includes(host.toLowerCase());
}

/** True for https://chatgpt.com and https://chat.openai.com (exact host, default port). */
export function isChatGptAppUrl(raw: string): boolean {
  const url = parseHttps(raw);
  return url !== null && hostIn(url.hostname, CHATGPT_APP_HOSTS);
}

/** Origin string form (e.g. "https://chatgpt.com") check, as delivered by permission handlers. */
export function isChatGptAppOrigin(origin: string): boolean {
  const url = parseHttps(origin);
  return url !== null && url.origin === origin.replace(/\/$/, '') && hostIn(url.hostname, CHATGPT_APP_HOSTS);
}

export function isAuthUrl(raw: string): boolean {
  const url = parseHttps(raw);
  return (
    url !== null &&
    (hostIn(url.hostname, OPENAI_AUTH_HOSTS) || hostIn(url.hostname, IDENTITY_PROVIDER_HOSTS) || GOOGLE_REGIONAL_ACCOUNTS_HOST.test(url.hostname.toLowerCase()))
  );
}

/** Top-level navigation allowlist for the ChatGPT surface. */
export function isAllowedTopLevelUrl(raw: string): boolean {
  return isChatGptAppUrl(raw) || isAuthUrl(raw);
}

/**
 * A conversation URL that may be persisted/restored for a Workspace (`chatConversationUrl` must
 * match approved ChatGPT origins/routes).
 */
export function isChatGptConversationUrl(raw: string): boolean {
  const url = parseHttps(raw);
  if (url === null || !hostIn(url.hostname, CHATGPT_APP_HOSTS)) return false;
  return /^\/(g\/[A-Za-z0-9-]+\/)?u?c\/[A-Za-z0-9-]+\/?$/.test(url.pathname);
}

/** A conversation URL as stored: origin and path only (a query or fragment can carry tokens). */
export function conversationUrlToStore(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname}`;
}

/** Only plain web links may be handed to the OS browser. */
export function isSafeExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
}
