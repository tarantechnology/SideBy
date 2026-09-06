import { RoomEngine, type IntentEnvelope, type RoomTimeline } from '@sideby/shared';
import type { MemberInfo, RoomSnapshot, Transport, TransportEvent, TransportStatus } from './Transport.js';

/**
 * Same-browser transport over BroadcastChannel, for developing sync
 * without a server. The tab with the smallest memberId among live tabs is
 * the leader and runs the RoomEngine; the others forward intents to it.
 * Clocks are shared, so serverNow() is just Date.now().
 */

type Wire =
  | { t: 'hello'; from: string; roomId: string; contentId: string | null }
  | { t: 'beat'; from: string; roomId: string; leader: boolean; revision: number }
  | { t: 'intent'; from: string; roomId: string; env: IntentEnvelope }
  | { t: 'snapshot'; from: string; roomId: string; timeline: RoomTimeline; members: string[] }
  | { t: 'bye'; from: string; roomId: string };

const BEAT_MS = 1000;
const DEAD_AFTER_MS = 3500;

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  readonly memberId: string;
  status: TransportStatus = 'idle';

  private channel: BroadcastChannel | null = null;
  private roomId: string | null = null;
  private contentId: string | null = null;
  private engine: RoomEngine | null = null;
  private lastTimeline: RoomTimeline | null = null;
  private peers = new Map<string, number>(); // memberId -> last seen
  private beatTimer: number | null = null;
  private listeners = new Set<(e: TransportEvent) => void>();

  constructor(memberId: string) {
    this.memberId = memberId;
  }

  get isLeader(): boolean {
    return this.engine !== null;
  }

  async join(roomId: string, contentId: string | null): Promise<void> {
    this.leave();
    this.roomId = roomId;
    this.contentId = contentId;
    this.channel = new BroadcastChannel(`sideby-local:${roomId}`);
    this.channel.onmessage = (ev: MessageEvent<Wire>) => this.receive(ev.data);
    this.setStatus('connecting');
    this.post({ t: 'hello', from: this.memberId, roomId, contentId });
    this.beatTimer = window.setInterval(() => this.beat(), BEAT_MS);
    // Give existing tabs a moment to answer before deciding leadership.
    await new Promise((r) => window.setTimeout(r, 400));
    this.electIfNeeded();
    this.setStatus('connected');
  }

  leave(): void {
    if (this.channel && this.roomId) this.post({ t: 'bye', from: this.memberId, roomId: this.roomId });
    if (this.beatTimer !== null) window.clearInterval(this.beatTimer);
    this.beatTimer = null;
    this.channel?.close();
    this.channel = null;
    this.engine = null;
    this.peers.clear();
    this.roomId = null;
    this.setStatus('closed');
  }

  send(env: IntentEnvelope): void {
    if (!this.roomId) return;
    if (this.engine) this.applyAsLeader(env);
    else this.post({ t: 'intent', from: this.memberId, roomId: this.roomId, env });
  }

  serverNow(): number {
    return Date.now();
  }

  rttMs(): number {
    return 2;
  }

  on(listener: (e: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------ internals

  private emit(e: TransportEvent): void {
    for (const l of this.listeners) l(e);
  }

  private setStatus(status: TransportStatus): void {
    this.status = status;
    this.emit({ type: 'status', status, detail: this.engine ? 'leader' : 'follower' });
  }

  private post(msg: Wire): void {
    this.channel?.postMessage(msg);
  }

  private liveMembers(): string[] {
    const now = Date.now();
    for (const [id, seen] of this.peers) if (now - seen > DEAD_AFTER_MS) this.peers.delete(id);
    return [this.memberId, ...this.peers.keys()].sort();
  }

  private electIfNeeded(): void {
    const leader = this.liveMembers()[0];
    if (leader === this.memberId && !this.engine) {
      this.engine = new RoomEngine(this.contentId, Date.now(), this.lastTimeline ?? undefined);
      this.setStatus('connected');
      this.broadcastSnapshot();
    } else if (leader !== this.memberId && this.engine) {
      // A smaller id appeared: hand over. Our last timeline travels via snapshots.
      this.engine = null;
      this.setStatus('connected');
    }
  }

  private beat(): void {
    if (!this.roomId) return;
    this.post({ t: 'beat', from: this.memberId, roomId: this.roomId, leader: this.isLeader, revision: this.lastTimeline?.revision ?? 0 });
    this.electIfNeeded();
    if (this.engine) this.broadcastSnapshot();
  }

  private applyAsLeader(env: IntentEnvelope): void {
    if (!this.engine) return;
    const result = this.engine.apply(env, Date.now());
    if (!result.accepted) {
      if (env.memberId === this.memberId) this.emit({ type: 'rejected', msgId: env.msgId, reason: result.reason ?? 'rejected' });
      return;
    }
    this.broadcastSnapshot();
  }

  private snapshot(timeline: RoomTimeline, memberIds: string[]): RoomSnapshot {
    const members: MemberInfo[] = memberIds.map((memberId) => ({ memberId, connected: true }));
    return { roomId: this.roomId!, timeline, members, serverNowMs: Date.now() };
  }

  private broadcastSnapshot(): void {
    if (!this.engine || !this.roomId) return;
    const members = this.liveMembers();
    this.lastTimeline = this.engine.timeline;
    this.post({ t: 'snapshot', from: this.memberId, roomId: this.roomId, timeline: this.engine.timeline, members });
    this.emit({ type: 'snapshot', snapshot: this.snapshot(this.engine.timeline, members) });
  }

  private receive(msg: Wire): void {
    if (msg.roomId !== this.roomId || msg.from === this.memberId) return;
    if (msg.t !== 'bye') this.peers.set(msg.from, Date.now());
    switch (msg.t) {
      case 'hello':
        this.electIfNeeded();
        if (this.engine) this.broadcastSnapshot();
        break;
      case 'beat':
        this.electIfNeeded();
        break;
      case 'intent':
        if (this.engine) this.applyAsLeader(msg.env);
        break;
      case 'snapshot':
        if (this.engine && msg.from > this.memberId) return; // ignore a stale leader
        if (this.lastTimeline && msg.timeline.revision < this.lastTimeline.revision) return;
        this.lastTimeline = msg.timeline;
        this.engine?.restore(msg.timeline);
        this.emit({ type: 'snapshot', snapshot: this.snapshot(msg.timeline, msg.members) });
        break;
      case 'bye':
        this.peers.delete(msg.from);
        this.electIfNeeded();
        break;
    }
  }
}
