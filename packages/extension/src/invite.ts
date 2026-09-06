/**
 * Invite links are plain Netflix URLs with the room attached, so a friend
 * with the extension lands on the right title and joins automatically:
 *   https://www.netflix.com/watch/<contentId>?sideby=<roomId>
 */
const PARAM = 'sideby';
const KEY_PENDING = 'sideby:pending';
const KEY_UNAVAILABLE = 'sideby:unavailable';
const PENDING_TTL_MS = 30 * 60 * 1000;
const WATCH_PATH = /^\/watch\/(\d+)/;

export interface PendingJoin {
  roomId: string;
  contentId: string | null;
  createdAtMs: number;
  /** Navigation attempts toward the title, to avoid redirect loops. */
  navAttempts: number;
}

export function buildInviteLink(contentId: string, roomId: string): string {
  return `https://www.netflix.com/watch/${contentId}?${PARAM}=${encodeURIComponent(roomId)}`;
}

export function contentIdFromPath(pathname: string = location.pathname): string | null {
  return WATCH_PATH.exec(pathname)?.[1] ?? null;
}

/** Reads and strips ?sideby= from the current URL. */
export function consumeInviteParam(): PendingJoin | null {
  const url = new URL(location.href);
  const roomId = url.searchParams.get(PARAM);
  if (!roomId) return null;
  url.searchParams.delete(PARAM);
  history.replaceState(history.state, '', url.toString());
  return { roomId, contentId: contentIdFromPath(url.pathname), createdAtMs: Date.now(), navAttempts: 0 };
}

export async function getPendingJoin(): Promise<PendingJoin | null> {
  const got = await chrome.storage.local.get(KEY_PENDING);
  const p = got[KEY_PENDING] as PendingJoin | undefined;
  if (!p?.roomId) return null;
  if (Date.now() - p.createdAtMs > PENDING_TTL_MS) { await clearPendingJoin(); return null; }
  return p;
}

export async function setPendingJoin(p: PendingJoin | null): Promise<void> {
  if (p) await chrome.storage.local.set({ [KEY_PENDING]: p });
  else await chrome.storage.local.remove(KEY_PENDING);
}

export async function clearPendingJoin(): Promise<void> {
  await chrome.storage.local.remove(KEY_PENDING);
}

/** Titles we tried to open and Netflix refused (plan, region, or removed). */
export async function markUnavailable(contentId: string): Promise<void> {
  const got = await chrome.storage.local.get(KEY_UNAVAILABLE);
  const list = (got[KEY_UNAVAILABLE] as string[] | undefined) ?? [];
  if (!list.includes(contentId)) await chrome.storage.local.set({ [KEY_UNAVAILABLE]: [...list, contentId].slice(-20) });
}

export async function isUnavailable(contentId: string): Promise<boolean> {
  const got = await chrome.storage.local.get(KEY_UNAVAILABLE);
  return ((got[KEY_UNAVAILABLE] as string[] | undefined) ?? []).includes(contentId);
}

/** Netflix's own "can't play this" surfaces. Best-effort; false negatives are fine. */
export function netflixShowsUnavailable(): boolean {
  if (document.querySelector('[data-uia="error-page"], [data-uia="nfplayer-error"], .nfp-error-page')) return true;
  const text = document.body?.innerText ?? '';
  return /not available|isn'?t available|unavailable in your|Error Code/i.test(text.slice(0, 2000));
}

export function isLoginOrGate(pathname: string = location.pathname): boolean {
  return /^\/(login|signup|SignUp|profiles|ProfilesGate|switchprofile|browse\/profiles|profilegate|LoginHelp)/i.test(pathname);
}
