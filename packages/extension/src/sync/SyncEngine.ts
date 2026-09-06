import { messageId, resolveAt, type Intent, type IntentEnvelope, type PlayerState, type Readiness, type RoomTimeline } from '@sideby/shared';
import { contentKey, parseContentKey, type ContentRef } from '../adapters/services.js';
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
  /** Resolved room playback state right now. */
  roomPlaying: boolean;
  seekLeadMs: number;
  rttMs: number;
  lastSent: string | null;
  lastReceived: string | null;
  rejected: number;
  config: SyncConfig;
  /** This member's preflight state as last reported. */
  readiness: Readiness;
  /** Whether we are currently holding the room because our player buffers. */
  holding: boolean;
  /** The other member, if any. */
  peer: MemberInfo | null;
  /** The title the room is on, if any, resolvable from any tab. */
  roomContent: ContentRef | null;
}

export interface SyncEngineOptions {
  /** Qualifies this player's title ids for the room ("netflix:70158900"); null when this tab has no player. */
  contentPrefix?: string | null;
  /** This tab is only here to hang out: no player, readiness says so, nothing to sync. */
  hangout?: boolean;
  /** Whether the service has let us past sign-in. Defaults to "on a title, or the player is ready". */
  loggedIn?: () => boolean;
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
  private holding = false;
  private holdTimer: number | null = null;
  private cameraReady = false;
  private lastReadiness: Readiness | null = null;

  constructor(
    private readonly adapter: VideoAdapter,
    private readonly transport: Transport,
    private readonly opts: SyncEngineOptions = {},
  ) {}

  /** The room-side key for a raw title id on this tab's service. */
  private key(contentId: string | null): string | null {
    return contentId && this.opts.contentPrefix ? contentKey(this.opts.contentPrefix, contentId) : null;
  }

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
    await this.transport.join(roomId, this.key(this.adapter.getState().contentId));
    // The first snapshot follows the join acknowledgement; give it a moment.
    for (let i = 0; i < 20 && !this.timeline; i++) await new Promise((r) => window.setTimeout(r, 50));
    const state = this.adapter.getState();
    const mine = this.key(state.contentId);
    if (mine && this.timeline && !this.timeline.contentId) {
      this.sendIntent({ kind: 'setContent', contentId: mine });
    }
    // Alone in the room: the room should reflect where we are, not reset us.
    if (this.members.length <= 1 && state.ready && this.timeline && this.timeline.contentId === mine) {
      this.sendIntent({ kind: 'seek', mediaMs: state.currentTimeMs, playing: state.playing });
    }
    this.reportReadiness();
    this.invalidate();
  }

  leave(): void {
    this.offAdapter?.();
    this.offTransport?.();
    this.offAdapter = this.offTransport = null;
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    if (this.startTimer !== null) window.clearTimeout(this.startTimer);
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.tickTimer = this.startTimer = this.holdTimer = null;
    this.holding = false;
    this.lastReadiness = null;
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

  /** Camera state feeds preflight; sync never depends on it. */
  setCameraReady(ready: boolean): void {
    this.cameraReady = ready;
    this.reportReadiness();
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
      contentMismatch: !!(this.timeline?.contentId && this.key(state.contentId) && this.timeline.contentId !== this.key(state.contentId)),
      startsInMs: resolved?.startsInMs ?? 0,
      roomPlaying: resolved?.playing ?? false,
      seekLeadMs: Math.round(this.seekLeadMs),
      rttMs: this.transport.rttMs(),
      lastSent: this.lastSent,
      lastReceived: this.lastReceived,
      rejected: this.rejected,
      config: this.config,
      readiness: this.computeReadiness(state),
      holding: this.holding,
      peer: this.members.find((m) => m.memberId !== this.transport.memberId) ?? null,
      roomContent: parseContentKey(this.timeline?.contentId),
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

  private computeReadiness(state: PlayerState): Readiness {
    const roomContent = this.timeline?.contentId ?? null;
    if (this.opts.hangout) {
      // Nothing to match or load here; once the room has a title, this tab is "not on it".
      return { loggedIn: true, contentMatch: !roomContent, playerReady: false, cameraReady: this.cameraReady, hangout: true };
    }
    const mine = this.key(state.contentId);
    return {
      // On a title page (the adapter parsed an id) the service let us through sign-in.
      loggedIn: this.opts.loggedIn ? this.opts.loggedIn() : !!state.contentId || state.ready,
      contentMatch: !!mine && (!roomContent || roomContent === mine),
      playerReady: state.ready,
      cameraReady: this.cameraReady,
    };
  }

  private reportReadiness(): void {
    if (!this.roomId) return;
    const r = this.computeReadiness(this.adapter.getState());
    const prev = this.lastReadiness;
    if (prev && prev.loggedIn === r.loggedIn && prev.contentMatch === r.contentMatch && prev.playerReady === r.playerReady && prev.cameraReady === r.cameraReady) return;
    this.lastReadiness = r;
    this.transport.sendReadiness(r);
    this.invalidate();
  }

  /**
   * Buffering → hold the room (after a short debounce so a momentary stall
   * does not pause the friend), release as soon as we can play again.
   */
  private trackBuffering(state: PlayerState): void {
    // Only a stall while the room is meant to be playing needs to hold anyone.
    const roomPlaying = !!this.timeline && (this.timeline.playing || this.timeline.playAtServerMs !== null);
    const stalled = state.buffering && !state.seeking && state.ready && roomPlaying;
    if (stalled && !this.holding && this.holdTimer === null) {
      this.holdTimer = window.setTimeout(() => {
        this.holdTimer = null;
        if (!this.roomId) return;
        this.holding = true;
        this.sendIntent({ kind: 'hold', on: true });
      }, this.config.holdDebounceMs);
    } else if (!stalled) {
      if (this.holdTimer !== null) { window.clearTimeout(this.holdTimer); this.holdTimer = null; }
      if (this.holding) {
        this.holding = false;
        this.sendIntent({ kind: 'hold', on: false });
      }
    }
  }

  /** Every adapter sample: detect user-initiated play/pause/seek. */
  private observe(state: PlayerState): void {
    const prev = this.prev;
    this.prev = state;
    if (!this.roomId) return;
    this.reportReadiness();
    if (!prev || !state.ready) return;
    this.trackBuffering(state);

    if (state.seeking && this.seekStartedAt === null) this.seekStartedAt = Date.now();
    if (!state.seeking && this.seekStartedAt !== null) {
      const took = Date.now() - this.seekStartedAt;
      this.seekStartedAt = null;
      if (took < 5000) this.seekLeadMs = this.seekLeadMs * 0.7 + took * 0.3;
    }

    // Play / pause transitions. Ignored while we buffer, or while someone
    // else's hold is what paused us; our own hold never hides our own press.
    const heldByOther = (this.timeline?.holds ?? []).some((m) => m !== this.transport.memberId);
    if (state.playing !== prev.playing && !state.buffering && !heldByOther) {
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
    const mine = this.key(contentId);
    if (!mine || !this.timeline || this.timeline.contentId === mine) return;
    // The service auto-advanced (or the user picked a new title): move the room.
    this.sendIntent({ kind: 'setContent', contentId: mine });
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
    // A brand-new room (nobody has acted yet) has nothing to impose.
    if (tl.revision <= 1 && this.members.length <= 1 && !tl.playing && tl.anchorMediaMs === 0) return;
    if (tl.contentId && this.key(state.contentId) && tl.contentId !== this.key(state.contentId)) return; // handled by preflight later

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
