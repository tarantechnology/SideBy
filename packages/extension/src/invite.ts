/**
 * Invite links are plain service URLs with the room attached, so a friend
 * with the extension lands on the right title and joins automatically:
 *   https://www.netflix.com/watch/<contentId>?sideby=<roomId>
 *   https://www.disneyplus.com/play/<contentId>?sideby=<roomId>
 *   https://www.hulu.com/watch/<contentId>?sideby=<roomId>
 * The domain carries the service; the service registry carries the rest.
 */
import { currentService, type ServiceId } from './adapters/services.js';

const PARAM = 'sideby';
const KEY_PENDING = 'sideby:pending';
const KEY_UNAVAILABLE = 'sideby:unavailable';
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface PendingJoin {
  roomId: string;
  contentId: string | null;
  /** Which service the title lives on; a pending join only continues there. */
  service: ServiceId | null;
  createdAtMs: number;
  /** Navigation attempts toward the title, to avoid redirect loops. */
  navAttempts: number;
}

export function buildInviteLink(contentId: string, roomId: string): string {
  const url = new URL(watchUrl(contentId) ?? location.href);
  url.searchParams.set(PARAM, roomId);
  return url.toString();
}

/** Playback URL for a title on the service this page belongs to; null off-service. */
export function watchUrl(contentId: string): string | null {
  return currentService()?.watchUrl(contentId) ?? null;
}

export function contentIdFromPath(pathname: string = location.pathname): string | null {
  return currentService()?.contentIdFromPath(pathname) ?? null;
}

export function isLoginOrGate(pathname: string = location.pathname): boolean {
  return currentService()?.isLoginOrGate(pathname) ?? false;
}

/** Reads and strips ?sideby= from the current URL. */
export function consumeInviteParam(): PendingJoin | null {
  const url = new URL(location.href);
  const roomId = url.searchParams.get(PARAM);
  if (!roomId) return null;
  url.searchParams.delete(PARAM);
  history.replaceState(history.state, '', url.toString());
  return { roomId, contentId: contentIdFromPath(url.pathname), service: currentService()?.id ?? null, createdAtMs: Date.now(), navAttempts: 0 };
}

/** The pending join for this service, if any. One for another service is left for that site. */
export async function getPendingJoin(): Promise<PendingJoin | null> {
  const got = await chrome.storage.local.get(KEY_PENDING);
  const p = got[KEY_PENDING] as PendingJoin | undefined;
  if (!p?.roomId) return null;
  if (Date.now() - p.createdAtMs > PENDING_TTL_MS) { await clearPendingJoin(); return null; }
  if (p.service && p.service !== currentService()?.id) return null;
  return p;
}

export async function setPendingJoin(p: PendingJoin | null): Promise<void> {
  if (p) await chrome.storage.local.set({ [KEY_PENDING]: p });
  else await chrome.storage.local.remove(KEY_PENDING);
}

export async function clearPendingJoin(): Promise<void> {
  await chrome.storage.local.remove(KEY_PENDING);
}

function unavailableKey(contentId: string): string {
  return `${currentService()?.id ?? 'unknown'}:${contentId}`;
}

/** Titles we tried to open and the service refused (plan, region, or removed). */
export async function markUnavailable(contentId: string): Promise<void> {
  const got = await chrome.storage.local.get(KEY_UNAVAILABLE);
  const list = (got[KEY_UNAVAILABLE] as string[] | undefined) ?? [];
  const key = unavailableKey(contentId);
  if (!list.includes(key)) await chrome.storage.local.set({ [KEY_UNAVAILABLE]: [...list, key].slice(-20) });
}

export async function isUnavailable(contentId: string): Promise<boolean> {
  const got = await chrome.storage.local.get(KEY_UNAVAILABLE);
  return ((got[KEY_UNAVAILABLE] as string[] | undefined) ?? []).includes(unavailableKey(contentId));
}

/** Netflix refused to play because this account already streams in another tab or browser. */
export function netflixShowsConcurrentStreams(): boolean {
  if (currentService()?.id !== 'netflix') return false;
  const text = (document.body?.innerText ?? '').slice(0, 3000);
  return /M7020|more than one browser or tab|too many people|M7111-5060/i.test(text);
}

/** The service's own "can't play this" surfaces. Best-effort; false negatives are fine. */
export function serviceShowsUnavailable(): boolean {
  const svc = currentService();
  if (!svc) return false;
  if (netflixShowsConcurrentStreams()) return false;
  if (document.querySelector(svc.unavailableSelectors)) return true;
  const text = (document.body?.innerText ?? '').slice(0, 2000);
  return svc.unavailableText.test(text);
}
