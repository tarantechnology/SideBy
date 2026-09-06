import { randomId } from '@sideby/shared';

/**
 * Identity and room membership are per tab (sessionStorage): a tab is one
 * seat in a room, a refresh keeps the seat, and a second tab is a second
 * seat rather than a takeover. Preferences are per browser (chrome.storage).
 */
const KEY_MEMBER = 'sideby:memberId';
const KEY_TOKEN = 'sideby:memberToken';
const KEY_ROOM = 'sideby:room';
const KEY_TRANSPORT = 'sideby:transport';

function tabGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function tabSet(key: string, value: string | null): void {
  try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* storage blocked */ }
}

export interface StoredRoom {
  roomId: string;
  transport: 'local' | 'ws';
  joinedAtMs: number;
  contentId?: string | null;
}

/** Per-tab identity; created on first use, survives refresh. */
export async function getMemberId(): Promise<string> {
  const existing = tabGet(KEY_MEMBER);
  if (existing) return existing;
  const id = randomId(10);
  tabSet(KEY_MEMBER, id);
  return id;
}

/** Secret proving ownership of the member id to the server. */
export async function getMemberToken(): Promise<string> {
  const existing = tabGet(KEY_TOKEN);
  if (existing) return existing;
  const token = randomId(32);
  tabSet(KEY_TOKEN, token);
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
  const raw = tabGet(KEY_ROOM);
  if (!raw) return null;
  try {
    const room = JSON.parse(raw) as StoredRoom;
    return room?.roomId ? room : null;
  } catch {
    return null;
  }
}

export async function setStoredRoom(room: StoredRoom | null): Promise<void> {
  tabSet(KEY_ROOM, room ? JSON.stringify(room) : null);
}
