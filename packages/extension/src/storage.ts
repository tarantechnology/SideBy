import { randomId } from '@sideby/shared';

/**
 * Identity and the current room belong to the browser session
 * (chrome.storage.session): a room follows you from tab to tab and site to
 * site, the server hands the seat to whichever tab joined last, and a fresh
 * browser starts clean. Preferences are per browser (chrome.storage.local).
 *
 * The dev mock page keeps a per-tab identity so it can stand in for a
 * second person next to a real service tab.
 */
const KEY_MEMBER = 'sideby:memberId';
const KEY_TOKEN = 'sideby:memberToken';
const KEY_ROOM = 'sideby:room';
const KEY_TRANSPORT = 'sideby:transport';

const perTab = location.pathname.startsWith('/mock');

async function get(key: string): Promise<string | null> {
  if (perTab) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }
  const area = chrome.storage.session ?? chrome.storage.local;
  const got = await area.get(key);
  const value = got[key];
  return typeof value === 'string' && value ? value : null;
}

async function set(key: string, value: string | null): Promise<void> {
  if (perTab) {
    try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* storage blocked */ }
    return;
  }
  const area = chrome.storage.session ?? chrome.storage.local;
  if (value === null) await area.remove(key);
  else await area.set({ [key]: value });
}

export interface StoredRoom {
  roomId: string;
  transport: 'local' | 'ws';
  joinedAtMs: number;
  /** Raw title id on `service`, when the room was joined from a title. */
  contentId?: string | null;
  service?: string | null;
}

/** Session identity; created on first use. */
export async function getMemberId(): Promise<string> {
  const existing = await get(KEY_MEMBER);
  if (existing) return existing;
  const id = randomId(10);
  await set(KEY_MEMBER, id);
  return id;
}

/** Secret proving ownership of the member id to the server. */
export async function getMemberToken(): Promise<string> {
  const existing = await get(KEY_TOKEN);
  if (existing) return existing;
  const token = randomId(32);
  await set(KEY_TOKEN, token);
  return token;
}

export async function getTransportPreference(): Promise<'local' | 'ws'> {
  const got = await chrome.storage.local.get(KEY_TRANSPORT);
  return got[KEY_TRANSPORT] === 'local' ? 'local' : 'ws';
}

export async function setTransportPreference(kind: 'local' | 'ws'): Promise<void> {
  await chrome.storage.local.set({ [KEY_TRANSPORT]: kind });
}

export async function getStoredRoom(): Promise<StoredRoom | null> {
  const raw = await get(KEY_ROOM);
  if (!raw) return null;
  try {
    const room = JSON.parse(raw) as StoredRoom;
    return room?.roomId ? room : null;
  } catch {
    return null;
  }
}

export async function setStoredRoom(room: StoredRoom | null): Promise<void> {
  await set(KEY_ROOM, room ? JSON.stringify(room) : null);
}
