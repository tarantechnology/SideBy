import { type IntentEnvelope, type Readiness, type ServerMessage, type WireMember } from '@sideby/shared';
import type { Member, Room, RoomStore } from './RoomStore.js';

export interface Connection {
  id: number;
  send(msg: ServerMessage): void;
}

/** A member is kept for this long after its socket drops (refresh, blip). */
export const MEMBER_GRACE_MS = 5 * 60 * 1000;
/** An empty room is deleted after this long. */
export const ROOM_TTL_MS = 10 * 60 * 1000;
/** Cap members per room while Sideby is 1:1 (host + friend, with slack for rejoin races). */
export const MAX_MEMBERS = 2;

const DEFAULT_READINESS: Readiness = { loggedIn: true, contentMatch: false, playerReady: false, cameraReady: false };

interface Session {
  conn: Connection;
  roomId: string;
  memberId: string;
}

/**
 * Transport-agnostic room logic: membership, snapshots, intents, RTC relay.
 * The WebSocket layer maps sockets to Connections and calls into here.
 */
export class RoomService {
  private sessions = new Map<number, Session>();
  private byMember = new Map<string, Connection>(); // `${roomId}/${memberId}` → active connection

  constructor(
    private readonly store: RoomStore,
    private readonly now: () => number = () => Date.now(),
    private readonly iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [{ urls: 'stun:stun.l.google.com:19302' }],
  ) {}

  join(conn: Connection, roomId: string, memberId: string, memberToken: string, contentId: string | null, name?: string): void {
    const nowMs = this.now();
    this.leave(conn, /* keepMember */ true);
    const room = this.store.getOrCreate(roomId, contentId, nowMs);

    const existing = room.members.get(memberId);
    if (existing && existing.memberToken !== memberToken) {
      conn.send({ type: 'error', code: 'member_token', message: 'That member id belongs to someone else.' });
      return;
    }
    if (!existing) {
      const live = [...room.members.values()].filter((m) => m.connected || nowMs - m.lastSeenMs < MEMBER_GRACE_MS);
      if (live.length >= MAX_MEMBERS) {
        conn.send({ type: 'error', code: 'room_full', message: 'This room already has two people.' });
        return;
      }
    }

    // A second socket for the same member (duplicate tab) replaces the first.
    const key = `${roomId}/${memberId}`;
    const prior = this.byMember.get(key);
    if (prior && prior.id !== conn.id) {
      this.sessions.delete(prior.id);
      prior.send({ type: 'error', code: 'replaced', message: 'Sideby is open in another tab.' });
    }

    const member: Member = existing ?? { memberId, memberToken, name, connected: true, readiness: { ...DEFAULT_READINESS }, lastSeenMs: nowMs };
    member.connected = true;
    member.lastSeenMs = nowMs;
    if (name) member.name = name;
    room.members.set(memberId, member);
    room.emptySinceMs = null;

    this.sessions.set(conn.id, { conn, roomId, memberId });
    this.byMember.set(key, conn);

    if (!room.engine.timeline.contentId && contentId) {
      room.engine.apply({ msgId: `join-${memberId}-${nowMs}`, memberId, baseRevision: room.engine.timeline.revision, atServerMs: nowMs, intent: { kind: 'setContent', contentId } }, nowMs);
    }

    conn.send({ type: 'joined', roomId, memberId, serverMs: nowMs, iceServers: this.iceServers });
    this.broadcast(room);
  }

  /** Socket closed or explicit leave. Members linger for MEMBER_GRACE_MS unless told otherwise. */
  leave(conn: Connection, keepMember = true): void {
    const session = this.sessions.get(conn.id);
    if (!session) return;
    this.sessions.delete(conn.id);
    const key = `${session.roomId}/${session.memberId}`;
    if (this.byMember.get(key)?.id === conn.id) this.byMember.delete(key);

    const room = this.store.get(session.roomId);
    if (!room) return;
    const member = room.members.get(session.memberId);
    const nowMs = this.now();
    if (member) {
      member.connected = false;
      member.lastSeenMs = nowMs;
      if (!keepMember) room.members.delete(session.memberId);
      // A dropped peer must not keep the room frozen; treat departure like a
      // hold so the friend pauses and everyone resumes together on return.
      room.engine.removeMember(session.memberId, nowMs);
      if (keepMember && room.engine.timeline.playing) this.pauseForDisconnect(room, session.memberId, nowMs);
    }
    if (![...room.members.values()].some((m) => m.connected)) room.emptySinceMs = nowMs;
    this.broadcast(room);
  }

  intent(conn: Connection, env: IntentEnvelope): void {
    const session = this.sessions.get(conn.id);
    if (!session) return conn.send({ type: 'error', code: 'not_joined', message: 'Join a room first.' });
    if (env.memberId !== session.memberId) return conn.send({ type: 'error', code: 'member_mismatch', message: 'Intent member does not match session.' });
    const room = this.store.get(session.roomId);
    if (!room) return;
    const nowMs = this.now();
    const result = room.engine.apply(env, nowMs);
    if (!result.accepted) {
      if (result.reason !== 'noop') conn.send({ type: 'rejected', msgId: env.msgId, reason: result.reason ?? 'rejected' });
      return;
    }
    this.broadcast(room);
  }

  readiness(conn: Connection, readiness: Readiness): void {
    const session = this.sessions.get(conn.id);
    const room = session && this.store.get(session.roomId);
    const member = room?.members.get(session!.memberId);
    if (!room || !member) return;
    member.readiness = readiness;
    this.broadcast(room);
  }

  relayRtc(conn: Connection, to: string, payload: unknown): void {
    const session = this.sessions.get(conn.id);
    if (!session) return;
    const target = this.byMember.get(`${session.roomId}/${to}`);
    target?.send({ type: 'rtc', from: session.memberId, payload });
  }

  snapshotFor(roomId: string): ServerMessage | null {
    const room = this.store.get(roomId);
    return room ? this.snapshot(room) : null;
  }

  /** Periodic: expire lingering members and empty rooms. */
  sweep(): void {
    const nowMs = this.now();
    for (const room of [...this.store.all()]) {
      for (const [id, m] of room.members) {
        if (!m.connected && nowMs - m.lastSeenMs > MEMBER_GRACE_MS) {
          room.members.delete(id);
          room.engine.removeMember(id, nowMs);
        }
      }
      if (room.members.size === 0 && room.emptySinceMs === null) room.emptySinceMs = nowMs;
      if (room.emptySinceMs !== null && nowMs - room.emptySinceMs > ROOM_TTL_MS) this.store.delete(room.roomId);
    }
  }

  private pauseForDisconnect(room: Room, memberId: string, nowMs: number): void {
    const tl = room.engine.timeline;
    const pos = room.engine.resolve(nowMs).positionMs;
    room.engine.apply({ msgId: `drop-${memberId}-${nowMs}`, memberId, baseRevision: tl.revision, atServerMs: nowMs, intent: { kind: 'pause', mediaMs: pos } }, nowMs);
  }

  private snapshot(room: Room): ServerMessage {
    const members: WireMember[] = [...room.members.values()].map((m) => ({ memberId: m.memberId, name: m.name, connected: m.connected, readiness: m.readiness }));
    return { type: 'snapshot', roomId: room.roomId, timeline: room.engine.timeline, members, serverMs: this.now() };
  }

  private broadcast(room: Room): void {
    const msg = this.snapshot(room);
    for (const session of this.sessions.values()) if (session.roomId === room.roomId) session.conn.send(msg);
  }
}
