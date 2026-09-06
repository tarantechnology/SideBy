import { EMPTY_PLAYER_STATE, type PlayerState } from '@sideby/shared';
import type { ServiceId, StreamingService } from './services.js';
import type {
  AdapterEvent,
  AdapterHealth,
  AdapterListener,
  ContentInfo,
  ControlPath,
  VideoAdapter,
} from './VideoAdapter.js';

const POLL_INTERVAL_MS = 250;
const MIN_EVENT_POLL_GAP_MS = 200;
/** After an ad ends, keep reporting the frozen content state until the player is back near it… */
const AD_RESUME_WINDOW_MS = 8000;
/** …or this long has passed (the service resumed somewhere else; trust it). */
const AD_RESUME_GRACE_MS = 4000;

/** Sample of a player, before the adapter stamps identity and time onto it. */
export type RawPlayerState = Omit<PlayerState, 'contentId' | 'sampledAtMs'>;

export function textOf(selector: string, root: ParentNode = document): string | undefined {
  const el = root.querySelector(selector);
  const text = el?.textContent?.trim();
  return text ? text : undefined;
}

/**
 * Everything an adapter needs that is not specific to one service: polling,
 * media-event wakeups, SPA navigation tracking, health accounting, listener
 * fan-out, and ad-break freezing. Subclasses supply how to find the player,
 * how to read it, and how to drive it.
 *
 * `Native` is the shape of the service's own player API when one is used
 * (Netflix); services driven purely through <video> leave it as `never`.
 *
 * Runs in the page's MAIN world.
 */
export abstract class BaseVideoAdapter<Native = never> implements VideoAdapter {
  readonly service: ServiceId;

  private listeners = new Set<AdapterListener>();
  private state: PlayerState = { ...EMPTY_PLAYER_STATE };
  private health: AdapterHealth = {
    path: 'none',
    apiFound: false,
    videoFound: false,
    attachedAtMs: null,
    polls: 0,
    playCalls: 0,
    pauseCalls: 0,
    seekCalls: 0,
    rateCalls: 0,
    failedCalls: 0,
    consecutiveReadErrors: 0,
    lastError: null,
    adBreak: false,
  };

  private pollTimer: number | null = null;
  private lastPollAt = 0;
  private video: HTMLVideoElement | null = null;
  private waiting = false;
  private wasReady = false;
  private lastContentId: string | null = null;
  private videoListeners: Array<[string, EventListener]> = [];
  private restoreHistory: (() => void) | null = null;

  /** Last sample taken outside an ad break; what we keep reporting during one. */
  private lastContentSample: RawPlayerState | null = null;
  private inAd = false;
  private adEndedAt: number | null = null;

  protected constructor(protected readonly def: StreamingService) {
    this.service = def.id;
    this.lastContentId = this.readContentId();
    this.state.contentId = this.lastContentId;
    this.watchNavigation();
    this.pollTimer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  // ------------------------------------------------------- service hooks

  /** The service's own player object, when it has a usable one. */
  protected resolveNative(): Native | null {
    return null;
  }

  /** The <video> element carrying the title. */
  protected findVideo(): HTMLVideoElement | null {
    return document.querySelector('video');
  }

  /** What is on screen: title and episode label. */
  protected abstract readTitle(): Pick<ContentInfo, 'title' | 'episode'>;

  /** True while the service is playing an ad instead of the title. */
  protected inAdBreak(_video: HTMLVideoElement | null): boolean {
    return false;
  }

  /** Reads the player. The default trusts the <video> element alone. */
  protected readState(_native: Native | null, video: HTMLVideoElement | null): RawPlayerState {
    if (!video) throw new Error('no player');
    const playing = !video.paused && !video.ended;
    const seeking = video.seeking;
    const stalled = playing && !seeking && video.readyState < 3;
    return {
      currentTimeMs: video.currentTime * 1000,
      durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0,
      playing,
      buffering: (this.waiting || stalled) && !video.ended,
      seeking,
      ended: video.ended,
      playbackRate: video.playbackRate,
      volume: video.volume,
      muted: video.muted,
      ready: video.readyState >= 2,
    };
  }

  protected doPlay(_native: Native | null, video: HTMLVideoElement | null): unknown {
    if (!video) throw new Error('no player');
    return video.play();
  }

  protected doPause(_native: Native | null, video: HTMLVideoElement | null): unknown {
    if (!video) throw new Error('no player');
    video.pause();
    return undefined;
  }

  protected doSeek(_native: Native | null, video: HTMLVideoElement | null, toMs: number): unknown {
    if (!video) throw new Error('no player');
    video.currentTime = toMs / 1000;
    return undefined;
  }

  protected doSetPlaybackRate(_native: Native | null, video: HTMLVideoElement | null, rate: number): unknown {
    if (!video) throw new Error('no player');
    video.playbackRate = rate;
    return undefined;
  }

  protected doSetVolume(_native: Native | null, video: HTMLVideoElement | null, volume: number): unknown {
    if (!video) throw new Error('no player');
    video.volume = volume;
    if (volume > 0) video.muted = false;
    return undefined;
  }

  // ---------------------------------------------------------------- reads

  getState(): PlayerState {
    return { ...this.state };
  }

  getContentInfo(): ContentInfo {
    let titles: Pick<ContentInfo, 'title' | 'episode'> = {};
    try {
      titles = this.readTitle();
    } catch {
      /* the page is mid-render; identity is what matters */
    }
    return { contentId: this.state.contentId, ...titles, url: location.href };
  }

  getHealth(): AdapterHealth {
    return { ...this.health };
  }

  // ------------------------------------------------------------- controls

  async play(): Promise<void> {
    this.health.playCalls++;
    await this.control('play', (n, v) => this.doPlay(n, v));
  }

  async pause(): Promise<void> {
    this.health.pauseCalls++;
    await this.control('pause', (n, v) => this.doPause(n, v));
  }

  async seek(toMs: number): Promise<void> {
    this.health.seekCalls++;
    const clamped = Math.max(0, Math.min(toMs, this.state.durationMs || toMs));
    await this.control('seek', (n, v) => this.doSeek(n, v, clamped));
  }

  async setPlaybackRate(rate: number): Promise<void> {
    this.health.rateCalls++;
    await this.control('rate', (n, v) => this.doSetPlaybackRate(n, v, rate));
  }

  async setVolume(volume: number): Promise<void> {
    const v = Math.max(0, Math.min(1, volume));
    await this.control('volume', (n, vid) => this.doSetVolume(n, vid, v));
  }

  on(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.detachVideo();
    this.restoreHistory?.();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ internals

  protected readContentId(): string | null {
    return this.def.contentIdFromPath(location.pathname);
  }

  protected emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[sideby] adapter listener threw', err);
      }
    }
  }

  protected fail(where: string, err: unknown): void {
    this.health.failedCalls++;
    this.health.lastError = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    this.emit({ type: 'error', message: this.health.lastError });
  }

  private async control(name: string, fn: (native: Native | null, video: HTMLVideoElement | null) => unknown): Promise<void> {
    // Volume is the viewer's own; everything else waits for the title to be back.
    if (this.inAd && name !== 'volume') return;
    try {
      await fn(this.resolveNative(), this.resolveVideo());
    } catch (err) {
      this.fail(name, err);
      throw err;
    }
  }

  private resolveVideo(): HTMLVideoElement | null {
    const current = this.findVideo();
    if (current !== this.video) {
      this.detachVideo();
      if (current) this.attachVideo(current);
    }
    return this.video;
  }

  private attachVideo(video: HTMLVideoElement): void {
    this.video = video;
    this.health.videoFound = true;
    this.health.attachedAtMs = Date.now();
    const add = (name: string, fn: EventListener) => {
      video.addEventListener(name, fn);
      this.videoListeners.push([name, fn]);
    };
    add('waiting', () => { this.waiting = true; this.poll(); });
    add('playing', () => { this.waiting = false; this.poll(); });
    add('canplay', () => { this.waiting = false; this.poll(); });
    add('seeking', () => this.poll());
    add('seeked', () => { this.waiting = false; this.poll(); });
    add('ratechange', () => this.poll());
    add('volumechange', () => this.poll());
    add('play', () => this.poll());
    add('pause', () => this.poll());
    add('ended', () => this.poll());
    // Media events keep firing in hidden tabs where timers are throttled to 1Hz.
    add('timeupdate', () => { if (Date.now() - this.lastPollAt >= MIN_EVENT_POLL_GAP_MS) this.poll(); });
  }

  private detachVideo(): void {
    if (this.video) {
      for (const [name, fn] of this.videoListeners) this.video.removeEventListener(name, fn);
    }
    this.videoListeners = [];
    this.video = null;
    this.health.videoFound = false;
    this.waiting = false;
  }

  private watchNavigation(): void {
    const check = () => this.checkContentChange();
    const history = window.history;
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = origPush.apply(this, args);
      queueMicrotask(check);
      return result;
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      const result = origReplace.apply(this, args);
      queueMicrotask(check);
      return result;
    };
    window.addEventListener('popstate', check);
    this.restoreHistory = () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', check);
    };
  }

  private checkContentChange(): void {
    const next = this.readContentId();
    if (next === this.lastContentId) return;
    const previous = this.lastContentId;
    this.lastContentId = next;
    this.state.contentId = next;
    this.wasReady = false;
    this.lastContentSample = null;
    this.inAd = false;
    this.adEndedAt = null;
    this.emit({ type: 'contentchange', contentId: next, previous });
  }

  private poll(): void {
    this.health.polls++;
    const now = Date.now();
    this.lastPollAt = now;
    this.checkContentChange();
    const native = this.resolveNative();
    const video = this.resolveVideo();
    this.health.apiFound = native !== null;

    let path: ControlPath = 'none';
    if (native) path = 'native-api';
    else if (video) path = 'video-element';
    this.health.path = path;

    if (!native && !video) {
      this.state = { ...EMPTY_PLAYER_STATE, contentId: this.lastContentId, sampledAtMs: now };
      this.emit({ type: 'state', state: this.getState() });
      return;
    }

    try {
      const raw = this.readState(native, video);
      const sample = this.applyAdBreak(raw, video, now);
      this.state = { ...sample, contentId: this.lastContentId, sampledAtMs: now };
      this.health.consecutiveReadErrors = 0;

      if (this.state.ready && !this.wasReady) {
        this.wasReady = true;
        this.emit({ type: 'ready' });
      }
      this.emit({ type: 'state', state: this.getState() });
    } catch (err) {
      this.health.consecutiveReadErrors++;
      this.fail('poll', err);
    }
  }

  /**
   * During an ad the <video> tells us about the ad, not the title. Report the
   * last content sample instead, marked as buffering so the room holds for
   * us (when it is playing) and nothing we see reads as a user seek or pause.
   * Before any content has played (a pre-roll) there is nothing to freeze:
   * report not-ready so the friend sees "Loading player".
   */
  private applyAdBreak(raw: RawPlayerState, video: HTMLVideoElement | null, now: number): RawPlayerState {
    let ad = false;
    try {
      ad = this.inAdBreak(video);
    } catch {
      /* detection is best-effort */
    }

    if (ad && !this.inAd) { this.inAd = true; this.adEndedAt = null; }
    if (!ad && this.inAd) { this.inAd = false; this.adEndedAt = now; }

    let frozen = ad;
    if (!ad && this.adEndedAt !== null) {
      const back = this.lastContentSample === null || Math.abs(raw.currentTimeMs - this.lastContentSample.currentTimeMs) < AD_RESUME_WINDOW_MS;
      if (back || now - this.adEndedAt > AD_RESUME_GRACE_MS) this.adEndedAt = null;
      else frozen = true;
    }
    this.health.adBreak = frozen;

    if (!frozen) {
      this.lastContentSample = raw;
      return raw;
    }
    const base = this.lastContentSample;
    if (!base) return { ...EMPTY_PLAYER_STATE, volume: raw.volume, muted: raw.muted, ready: false };
    return { ...base, buffering: true, seeking: false, volume: raw.volume, muted: raw.muted };
  }
}
