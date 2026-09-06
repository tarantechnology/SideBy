import { EMPTY_PLAYER_STATE, type PlayerState } from '@sideby/shared';
import type { AdapterEvent, AdapterHealth, AdapterListener, ContentInfo, VideoAdapter } from '../VideoAdapter.js';

/**
 * A VideoAdapter over an ordinary <video>. Used by the dev mock page so the
 * sync engine can be exercised end to end against a second player that is
 * not bound by Netflix's one-stream-per-account rule.
 */
export class MockAdapter implements VideoAdapter {
  readonly service = 'mock';
  private listeners = new Set<AdapterListener>();
  private state: PlayerState = { ...EMPTY_PLAYER_STATE };
  private health: AdapterHealth = { path: 'video-element', apiFound: false, videoFound: true, attachedAtMs: Date.now(), polls: 0, playCalls: 0, pauseCalls: 0, seekCalls: 0, rateCalls: 0, failedCalls: 0, consecutiveReadErrors: 0, lastError: null };
  private waiting = false;
  private wasReady = false;
  private timer: number;

  constructor(private readonly video: HTMLVideoElement, private readonly contentId: string) {
    for (const ev of ['waiting', 'playing', 'canplay', 'seeking', 'seeked', 'ratechange', 'play', 'pause', 'ended', 'volumechange', 'timeupdate', 'loadedmetadata']) {
      video.addEventListener(ev, () => {
        if (ev === 'waiting') this.waiting = true;
        if (ev === 'playing' || ev === 'canplay' || ev === 'seeked') this.waiting = false;
        this.poll();
      });
    }
    this.timer = window.setInterval(() => this.poll(), 250);
    this.poll();
  }

  getState(): PlayerState { return { ...this.state }; }
  getContentInfo(): ContentInfo { return { contentId: this.contentId, title: 'Mock player', url: location.href }; }
  getHealth(): AdapterHealth { return { ...this.health }; }
  async play(): Promise<void> { this.health.playCalls++; await this.video.play(); }
  async pause(): Promise<void> { this.health.pauseCalls++; this.video.pause(); }
  async seek(toMs: number): Promise<void> { this.health.seekCalls++; this.video.currentTime = Math.max(0, toMs) / 1000; }
  async setPlaybackRate(rate: number): Promise<void> { this.health.rateCalls++; this.video.playbackRate = rate; }
  async setVolume(volume: number): Promise<void> { this.video.volume = Math.max(0, Math.min(1, volume)); if (volume > 0) this.video.muted = false; }
  on(listener: AdapterListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  destroy(): void { window.clearInterval(this.timer); this.listeners.clear(); }

  private emit(e: AdapterEvent): void { for (const l of this.listeners) l(e); }

  private poll(): void {
    const v = this.video;
    this.health.polls++;
    const ready = v.readyState >= 2;
    const playing = !v.paused && !v.ended;
    this.state = {
      contentId: this.contentId,
      currentTimeMs: v.currentTime * 1000,
      durationMs: Number.isFinite(v.duration) ? v.duration * 1000 : 0,
      playing,
      buffering: (this.waiting || (playing && v.readyState < 3)) && !v.ended,
      seeking: v.seeking,
      ended: v.ended,
      playbackRate: v.playbackRate,
      volume: v.volume,
      muted: v.muted,
      ready,
      sampledAtMs: Date.now(),
    };
    if (ready && !this.wasReady) { this.wasReady = true; this.emit({ type: 'ready' }); }
    this.emit({ type: 'state', state: this.getState() });
  }
}
