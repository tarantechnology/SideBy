import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@sideby/shared';
import { RoomService, type Connection } from '../src/RoomService.js';
import { MemoryRoomStore } from '../src/RoomStore.js';

function conn(id: number): Connection & { out: ServerMessage[] } {
  const out: ServerMessage[] = [];
  return { id, out, send: (m) => { out.push(m); } };
}
const last = (c: { out: ServerMessage[] }, type: ServerMessage['type']) => [...c.out].reverse().find((m) => m.type === type) as ServerMessage | undefined;

describe('RoomService', () => {
  it('creates a room on first join, adopts the joiner content, and snapshots both members', () => {
    let t = 1000;
    const svc = new RoomService(new MemoryRoomStore(), () => t);
    const a = conn(1), b = conn(2);
    svc.join(a, 'r1', 'A', 'tokA', 'ep1');
    t += 10;
    svc.join(b, 'r1', 'B', 'tokB', 'ep1');
    const snap = last(b, 'snapshot');
    expect(snap).toMatchObject({ type: 'snapshot', timeline: { contentId: 'ep1' } });
    expect((snap as { members: unknown[] }).members).toHaveLength(2);
    expect(last(a, 'snapshot')).toEqual(snap);
  });

  it('refuses a third member and a stolen member id', () => {
    const svc = new RoomService(new MemoryRoomStore(), () => 0);
    svc.join(conn(1), 'r', 'A', 'ta', null);
    svc.join(conn(2), 'r', 'B', 'tb', null);
    const c = conn(3);
    svc.join(c, 'r', 'C', 'tc', null);
    expect(last(c, 'error')).toMatchObject({ code: 'room_full' });
    const thief = conn(4);
    svc.join(thief, 'r', 'A', 'wrong', null);
    expect(last(thief, 'error')).toMatchObject({ code: 'member_token' });
  });

  it('applies intents, rejects duplicates, and relays snapshots to peers', () => {
    const svc = new RoomService(new MemoryRoomStore(), () => 5000);
    const a = conn(1), b = conn(2);
    svc.join(a, 'r', 'A', 'ta', 'x');
    svc.join(b, 'r', 'B', 'tb', 'x');
    const env = { msgId: 'm1', memberId: 'A', baseRevision: 1, atServerMs: 4990, intent: { kind: 'play' as const, mediaMs: 100 } };
    svc.intent(a, env);
    expect(last(b, 'snapshot')).toMatchObject({ timeline: { playing: true, anchorMediaMs: 100, anchorServerMs: 4990 } });
    svc.intent(a, env);
    expect(last(a, 'rejected')).toMatchObject({ msgId: 'm1', reason: 'duplicate' });
    svc.intent(b, { ...env, msgId: 'm2', memberId: 'A' });
    expect(last(b, 'error')).toMatchObject({ code: 'member_mismatch' });
  });

  it('pauses the room when a member drops, keeps it through the grace period, and expires later', () => {
    let t = 0;
    const store = new MemoryRoomStore();
    const svc = new RoomService(store, () => t);
    const a = conn(1), b = conn(2);
    svc.join(a, 'r', 'A', 'ta', 'x');
    svc.join(b, 'r', 'B', 'tb', 'x');
    svc.intent(a, { msgId: 'p', memberId: 'A', baseRevision: 1, atServerMs: 0, intent: { kind: 'play', mediaMs: 0 } });
    t = 10_000;
    svc.leave(b, true);
    const snap = last(a, 'snapshot') as { timeline: { playing: boolean; anchorMediaMs: number }; members: { memberId: string; connected: boolean }[] };
    expect(snap.timeline).toMatchObject({ playing: false, anchorMediaMs: 10_000 });
    expect(snap.members.find((m) => m.memberId === 'B')).toMatchObject({ connected: false });

    t = 60_000;
    svc.sweep();
    expect(store.get('r')?.members.has('B')).toBe(true);
    t = 10 * 60_000;
    svc.sweep();
    expect(store.get('r')?.members.has('B')).toBe(false);

    svc.leave(a, true);
    t = 21 * 60_000;
    svc.sweep();
    expect(store.get('r')).toBeUndefined();
  });

  it('relays rtc payloads to the addressed member only', () => {
    const svc = new RoomService(new MemoryRoomStore(), () => 0);
    const a = conn(1), b = conn(2);
    svc.join(a, 'r', 'A', 'ta', null);
    svc.join(b, 'r', 'B', 'tb', null);
    svc.relayRtc(a, 'B', { sdp: 'offer' });
    expect(last(b, 'rtc')).toEqual({ type: 'rtc', from: 'A', payload: { sdp: 'offer' } });
    expect(last(a, 'rtc')).toBeUndefined();
  });
});
