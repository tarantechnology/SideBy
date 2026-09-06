import { randomId } from '@sideby/shared';

const KEY_MEMBER = 'sideby:memberId';
const KEY_ROOM = 'sideby:room';

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

export async function getStoredRoom(): Promise<StoredRoom | null> {
  const got = await chrome.storage.local.get(KEY_ROOM);
  const room = got[KEY_ROOM] as StoredRoom | undefined;
  return room?.roomId ? room : null;
}

export async function setStoredRoom(room: StoredRoom | null): Promise<void> {
  if (room) await chrome.storage.local.set({ [KEY_ROOM]: room });
  else await chrome.storage.local.remove(KEY_ROOM);
}
