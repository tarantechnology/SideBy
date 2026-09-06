import { messageId, resolveAt, type Intent, type IntentEnvelope, type PlayerState, type RoomTimeline } from '@sideby/shared';
import type { VideoAdapter } from '../adapters/VideoAdapter.js';
import type { MemberInfo, Transport, TransportStatus } from '../transport/Transport.js';
import { DEFAULT_SYNC_CONFIG, type SyncConfig } from './config.js';
import { DriftController, type Correction } from './DriftController.js';

export interface SyncSnapshot {
  roomId: string | null;
  status: TransportStatus;
  role: string;
  members: MemberInfo[];
  timeline: RoomTimeline | null;
  expectedMs: number | null;
  driftMs: number | null;
  correction: 'none' | 'slow' | 'fast' | 'seek';
  contentMismatch: boolean;
  startsInMs: number;
  seekLeadMs: number;
  rttMs: number;
  lastSent: string | null;
  lastReceived: string | null;
  rejected: number;
  config: SyncConfig;
}

type Expectation =
  | { kind: 'playing'; value: boolean; untilMs: number }
  | { kind: 'position'; ms: number; untilMs: number };

/**
 * Bridges one VideoAdapter to a room Transport.
 *  - Turns user actions observed on the adapter into intents.
 *  - Applies authoritative snapshots to the adapter.
 *  - Periodically measures drift against the room timeline and corrects it.
 */
export class SyncEngine {
  private config: SyncConfig = { ...DEFAULT_SYNC_CONFIG };
  private drift = new DriftController(() => this.config);
  private timeline: RoomTimeline | null = null;
  private members: MemberInfo[] = [];
  private roomId: string | null = null;
  private prev: PlayerState | null = null;
  private expectations: Expectation[] = [];
  private tickTimer: number | null = null;
  private startTimer: number | null = null;
  private offAdapter: (() => void) | null = null;
  private offTransport: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private snapshotCache: SyncSnapshot | null = null;
  private lastDriftMs: number | null = null;
  private lastExpectedMs: number | null = null;
  private lastCorrection: SyncSnapshot['correction'] = 'none';
  private lastSent: string | null = null;
  private lastReceived: string | null = null;
  private rejected = 0;
  private seekLeadMs = 250;
  private seekStartedAt: number | null = null;

  constructor(private readonly adapter: VideoAdapter, private readonly transport: Transport) {}

  // ---------------------------------------------------------------- public

  async join(roomId: string): Promise<void> {
    this.leave();
    this.roomId = roomId;
    this.prev = this.adapter.getState();
    this.offAdapter = this.adapter.on((ev) => {
      if (ev.type === 'state') this.observe(ev.state);
      if (ev.type === 'contentchange' && ev.contentId) this.onContentChange(ev.contentId);
    });
    this.offTransport = this.transport.on((ev) => {
      if (ev.type === 'snapshot') {
        this.members = ev.snapshot.members;
        this.receive(ev.snapshot.timeline);
      } else if (ev.type === 'rejected') {
        this.rejected++;
        this.invalidate();
      } else {
        this.invalidate();
      }
    });
    this.tickTimer = window.setInterval(() => this.tick(), this.config.tickMs);
    await this.transport.join(roomId, this.adapter.getState().contentId);
    // Claim content for a fresh room.
    const state = this.adapter.getState();
    if (state.contentId && this.timeline && !this.timeline.contentId) {
      this.sendIntent({ kind: 'setContent', contentId: state.contentId });
    }
    this.invalidate();
  }

  leave(): void {
    this.offAdapter?.();
    this.offTransport?.();
    this.offAdapter = this.offTransport = null;
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    if (this.startTimer !== null) window.clearTimeout(this.startTimer);
    this.tickTimer = this.startTimer = null;
    if (this.roomId) this.transport.leave();
    this.roomId = null;
    this.timeline = null;
    this.members = [];
    this.expectations = [];
    this.drift.reset();
    this.lastDriftMs = this.lastExpectedMs = null;
    this.lastCorrection = 'none';
    void this.adapter.setPlaybackRate(1).catch(() => undefined);
    this.invalidate();
  }

  setConfig(patch: Partial<SyncConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.tickMs && this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = window.setInterval(() => this.tick(), this.config.tickMs);
    }
    this.invalidate();
  }

  /** Start everyone together after a short countdown. */
  startTogether(delayMs = 3000): void {
    const state = this.adapter.getState();
    this.sendIntent({ kind: 'schedulePlay', mediaMs: state.currentTimeMs, delayMs });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncSnapshot {
    if (this.snapshotCache) return this.snapshotCache;
    const state = this.adapter.getState();
    const now = this.transport.serverNow();
    const resolved = this.timeline ? resolveAt(this.timeline, now) : null;
    this.snapshotCache = {
      roomId: this.roomId,
      status: this.transport.status,
      role: this.transport.kind === 'local' && (this.transport as { isLeader?: boolean }).isLeader ? 'leader' : this.transport.kind,
      members: this.members,
      timeline: this.timeline,
      expectedMs: this.lastExpectedMs,
      driftMs: this.lastDriftMs,
      correction: this.lastCorrection,
      contentMismatch: !!(this.timeline?.contentId && state.contentId && this.timeline.contentId !== state.contentId),
      startsInMs: resolved?.startsInMs ?? 0,
      seekLeadMs: Math.round(this.seekLeadMs),
      rttMs: this.transport.rttMs(),
      lastSent: this.lastSent,
      lastReceived: this.lastReceived,
      rejected: this.rejected,
      config: this.config,
    };
    return this.snapshotCache;
  }

  // ----------------------------------------------------------- observing

  private invalidate(): void {
    this.snapshotCache = null;
    for (const l of this.listeners) l();
  }

  private sendIntent(intent: Intent): void {
    if (!this.roomId) return;
    const env: IntentEnvelope = {
      msgId: messageId(),
      memberId: this.transport.memberId,
      baseRevision: this.timeline?.revision ?? 0,
      atServerMs: this.transport.serverNow(),
      intent,
    };
    this.transport.send(env);
    this.lastSent = describeIntent(intent);
    this.invalidate();
  }

  private expect(e: { kind: 'playing'; value: boolean } | { kind: 'position'; ms: number }): void {
    const untilMs = Date.now() + this.config.echoWindowMs;
    this.expectations.push({ ...e, untilMs });
  }

  private consumeExpectation(pred: (e: Expectation) => boolean): boolean {
    const now = Date.now();
    this.expectations = this.expectations.filter((e) => e.untilMs > now);
    const idx = this.expectations.findIndex(pred);
    if (idx === -1) return false;
    this.expectations.splice(idx, 1);
    return true;
  }

  /** Every adapter sample: detect user-initiated play/pause/seek. */
  private observe(state: PlayerState): void {
    const prev = this.prev;
    this.prev = state;
    if (!prev || !state.ready || !this.roomId) return;

    if (state.seeking && this.seekStartedAt === null) this.seekStartedAt = Date.now();
    if (!state.seeking && this.seekStartedAt !== null) {
      const took = Date.now() - this.seekStartedAt;
      this.seekStartedAt = null;
      if (took < 5000) this.seekLeadMs = this.seekLeadMs * 0.7 + took * 0.3;
    }

    // Play / pause transitions.
    if (state.playing !== prev.playing && !state.buffering) {
      const echoed = this.consumeExpectation((e) => e.kind === 'playing' && e.value === state.playing);
      if (!echoed) {
        if (state.playing) this.sendIntent({ kind: 'play', mediaMs: state.currentTimeMs });
        else if (!state.ended) this.sendIntent({ kind: 'pause', mediaMs: state.currentTimeMs });
      }
    }

    // Seeks: a jump beyond natural progress since the previous sample.
    if (!state.seeking) {
      const elapsed = Math.max(0, state.sampledAtMs - prev.sampledAtMs);
      const natural = prev.currentTimeMs + (prev.playing ? elapsed * prev.playbackRate : 0);
      const jump = state.currentTimeMs - natural;
      if (Math.abs(jump) > this.config.userSeekJumpMs) {
        const echoed = this.consumeExpectation((e) => e.kind === 'position' && Math.abs(e.ms - state.currentTimeMs) < 3000);
        if (!echoed) this.sendIntent({ kind: 'seek', mediaMs: state.currentTimeMs, playing: state.playing });
      }
    }
  }

  private onContentChange(contentId: string): void {
    if (!this.timeline || this.timeline.contentId === contentId) return;
    // Netflix auto-advanced (or the user picked a new title): move the room.
    this.sendIntent({ kind: 'setContent', contentId });
  }

  // ------------------------------------------------------------ applying

  private receive(tl: RoomTimeline): void {
    const prevRev = this.timeline?.revision ?? -1;
    if (tl.revision < prevRev) return; // stale snapshot
    const changed = tl.revision !== prevRev;
    this.timeline = tl;
    if (changed) {
      this.lastReceived = `rev ${tl.revision} by ${tl.updatedBy ?? '—'}`;
      this.apply();
    }
    this.invalidate();
  }

  private apply(): void {
    const tl = this.timeline;
    if (!tl) return;
    const state = this.adapter.getState();
    if (!state.ready) return;
    if (tl.contentId && state.contentId && tl.contentId !== state.contentId) return; // handled by preflight later

    const now = this.transport.serverNow();
    const resolved = resolveAt(tl, now);

    if (this.startTimer !== null) { window.clearTimeout(this.startTimer); this.startTimer = null; }

    if (resolved.startsInMs > 0) {
      // Scheduled start: park at the anchor, then play at the server instant.
      if (state.playing) this.command('pause');
      if (Math.abs(state.currentTimeMs - tl.anchorMediaMs) > this.config.deadbandMs) this.command('seek', tl.anchorMediaMs);
      this.startTimer = window.setTimeout(() => {
        this.startTimer = null;
        this.command('play');
        this.invalidate();
      }, Math.max(0, resolved.startsInMs - this.transport.rttMs() / 2));
      return;
    }

    if (resolved.playing !== state.playing) this.command(resolved.playing ? 'play' : 'pause');

    const projected = resolved.playing ? resolved.positionMs + this.seekLeadMs : resolved.positionMs;
    const driftMs = state.currentTimeMs - resolved.positionMs;
    if (Math.abs(driftMs) >= this.config.hardSeekMs || (!resolved.playing && Math.abs(driftMs) >= this.config.deadbandMs)) {
      this.command('seek', projected);
      this.lastCorrection = 'seek';
    }
  }

  private command(kind: 'play' | 'pause' | 'seek', ms?: number): void {
    if (kind === 'play') { this.expect({ kind: 'playing', value: true }); void this.adapter.play().catch(() => undefined); }
    if (kind === 'pause') { this.expect({ kind: 'playing', value: false }); void this.adapter.pause().catch(() => undefined); }
    if (kind === 'seek' && ms !== undefined) {
      const target = Math.max(0, ms);
      this.expect({ kind: 'position', ms: target });
      this.seekStartedAt = Date.now();
      void this.adapter.seek(target).catch(() => undefined);
    }
  }

  /** Periodic drift evaluation against the room timeline. */
  private tick(): void {
    const tl = this.timeline;
    if (!tl || !this.roomId) return;
    const state = this.adapter.getState();
    const now = this.transport.serverNow();
    const resolved = resolveAt(tl, now);
    this.lastExpectedMs = resolved.positionMs;

    const idle = !resolved.playing || !state.playing || state.buffering || state.seeking || !state.ready;
    if (idle) {
      this.lastDriftMs = state.ready ? state.currentTimeMs - resolved.positionMs : null;
      if (this.drift.isNudging) { this.drift.reset(); void this.adapter.setPlaybackRate(1).catch(() => undefined); }
      this.lastCorrection = 'none';
      this.invalidate();
      return;
    }

    // Project the sample forward to "now" so poll latency does not read as drift.
    const ageMs = Math.max(0, Date.now() - state.sampledAtMs);
    const actual = state.currentTimeMs + ageMs * state.playbackRate;
    const driftMs = actual - resolved.positionMs;
    this.lastDriftMs = driftMs;

    const correction: Correction = this.drift.decide(driftMs);
    if (correction.kind === 'rate') {
      if (Math.abs(state.playbackRate - correction.rate) > 0.001) void this.adapter.setPlaybackRate(correction.rate).catch(() => undefined);
      this.lastCorrection = correction.rate === 1 ? 'none' : correction.rate < 1 ? 'slow' : 'fast';
    } else if (correction.kind === 'seek') {
      if (Math.abs(state.playbackRate - 1) > 0.001) void this.adapter.setPlaybackRate(1).catch(() => undefined);
      this.command('seek', resolved.positionMs + this.seekLeadMs);
      this.lastCorrection = 'seek';
    } else {
      this.lastCorrection = 'none';
    }
    this.invalidate();
  }
}

function describeIntent(i: Intent): string {
  switch (i.kind) {
    case 'play': return `play @${(i.mediaMs / 1000).toFixed(1)}s`;
    case 'pause': return `pause @${(i.mediaMs / 1000).toFixed(1)}s`;
    case 'seek': return `seek →${(i.mediaMs / 1000).toFixed(1)}s`;
    case 'setContent': return `content ${i.contentId}`;
    case 'schedulePlay': return `start in ${i.delayMs}ms`;
    case 'hold': return i.on ? 'hold' : 'release';
  }
}
