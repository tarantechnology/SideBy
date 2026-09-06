import { randomId } from '@sideby/shared';

const KEY_MEMBER = 'sideby:memberId';
const KEY_TOKEN = 'sideby:memberToken';
const KEY_ROOM = 'sideby:room';
const KEY_TRANSPORT = 'sideby:transport';

export interface StoredRoom {
  roomId: string;
  transport: 'local' | 'ws';
  joinedAtMs: number;
}

/** Stable per-browser identity; created on first use. */
export async function getMemberId(): Promise<string> {
  const got = await chrome.storage.local.get(KEY_MEMBER);
  const existing = got[KEY_MEMBER];
  if (typeof existing === 'string' && existing) return existing;
  const id = randomId(10);
  await chrome.storage.local.set({ [KEY_MEMBER]: id });
  return id;
}

/** Secret proving ownership of the member id to the server. */
export async function getMemberToken(): Promise<string> {
  const got = await chrome.storage.local.get(KEY_TOKEN);
  const existing = got[KEY_TOKEN];
  if (typeof existing === 'string' && existing) return existing;
  const token = randomId(32);
  await chrome.storage.local.set({ [KEY_TOKEN]: token });
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
  const got = await chrome.storage.local.get(KEY_ROOM);
  const room = got[KEY_ROOM] as StoredRoom | undefined;
  return room?.roomId ? room : null;
}

export async function setStoredRoom(room: StoredRoom | null): Promise<void> {
  if (room) await chrome.storage.local.set({ [KEY_ROOM]: room });
  else await chrome.storage.local.remove(KEY_ROOM);
}
