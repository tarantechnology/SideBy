import { EMPTY_PLAYER_STATE, type PlayerState } from '@sideby/shared';
import type {
  AdapterEvent,
  AdapterHealth,
  AdapterListener,
  ContentInfo,
  ControlPath,
  VideoAdapter,
} from '../VideoAdapter.js';

/**
 * Shape of the parts of Netflix's internal player API that we touch.
 * Everything is optional: Netflix can rename or remove any of it, and the
 * adapter must degrade to the <video> element rather than crash.
 */
interface NetflixSessionPlayer {
  getCurrentTime?: () => number;
  getDuration?: () => number;
  isPlaying?: () => boolean;
  isPaused?: () => boolean;
  isReady?: () => boolean;
  isEnded?: () => boolean;
  getBusy?: () => boolean;
  play?: () => void;
  pause?: () => void;
  seek?: (ms: number) => void;
  getPlaybackRate?: () => number;
  setPlaybackRate?: (rate: number) => void;
}

interface NetflixVideoPlayerApi {
  getAllPlayerSessionIds?: () => string[];
  getVideoPlayerBySessionId?: (id: string) => NetflixSessionPlayer | undefined;
}

const POLL_INTERVAL_MS = 250;
const MIN_EVENT_POLL_GAP_MS = 200;
const WATCH_PATH = /^\/watch\/(\d+)/;

function readContentIdFromUrl(): string | null {
  const match = WATCH_PATH.exec(location.pathname);
  return match?.[1] ?? null;
}

function textOf(selector: string): string | undefined {
  const el = document.querySelector(selector);
  const text = el?.textContent?.trim();
  return text ? text : undefined;
}

/**
 * Observes and controls the Netflix player without touching its media
 * pipeline. Prefers Netflix's own player API (which drives its UI and
 * seek logic correctly); falls back to the raw <video> element.
 * Runs in the page's MAIN world.
 */
export class NetflixAdapter implements VideoAdapter {
  readonly service = 'netflix';

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
  };

  private pollTimer: number | null = null;
  private lastPollAt = 0;
  private video: HTMLVideoElement | null = null;
  private waiting = false;
  private wasReady = false;
  private lastContentId: string | null = null;
  private videoListeners: Array<[string, EventListener]> = [];
  private restoreHistory: (() => void) | null = null;

  constructor() {
    this.lastContentId = readContentIdFromUrl();
    this.state.contentId = this.lastContentId;
    this.watchNavigation();
    this.pollTimer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll();
  }

  // ---------------------------------------------------------------- reads

  getState(): PlayerState {
    return { ...this.state };
  }

  getContentInfo(): ContentInfo {
    return {
      contentId: this.state.contentId,
      title: textOf('[data-uia="video-title"] h4') ?? textOf('[data-uia="video-title"]'),
      episode: textOf('[data-uia="video-title"] span'),
      url: location.href,
    };
  }

  getHealth(): AdapterHealth {
    return { ...this.health };
  }

  // ------------------------------------------------------------- controls

  async play(): Promise<void> {
    this.health.playCalls++;
    await this.control('play', (player, video) => {
      if (player?.play) return player.play();
      if (video) return video.play();
      throw new Error('no player');
    });
  }

  async pause(): Promise<void> {
    this.health.pauseCalls++;
    await this.control('pause', (player, video) => {
      if (player?.pause) return player.pause();
      if (video) return video.pause();
      throw new Error('no player');
    });
  }

  async seek(toMs: number): Promise<void> {
    this.health.seekCalls++;
    const clamped = Math.max(0, Math.min(toMs, this.state.durationMs || toMs));
    await this.control('seek', (player, video) => {
      if (player?.seek) return player.seek(clamped);
      if (video) {
        video.currentTime = clamped / 1000;
        return;
      }
      throw new Error('no player');
    });
  }

  async setPlaybackRate(rate: number): Promise<void> {
    this.health.rateCalls++;
    await this.control('rate', (player, video) => {
      // The <video> element is authoritative for rate: Netflix's own speed
      // control ultimately sets video.playbackRate too.
      if (video) {
        video.playbackRate = rate;
        return;
      }
      if (player?.setPlaybackRate) return player.setPlaybackRate(rate);
      throw new Error('no player');
    });
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

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[sideby] adapter listener threw', err);
      }
    }
  }

  private fail(where: string, err: unknown): void {
    this.health.failedCalls++;
    this.health.lastError = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    this.emit({ type: 'error', message: this.health.lastError });
  }

  private async control(
    name: string,
    fn: (player: NetflixSessionPlayer | null, video: HTMLVideoElement | null) => unknown,
  ): Promise<void> {
    try {
      await fn(this.resolvePlayer(), this.resolveVideo());
    } catch (err) {
      this.fail(name, err);
      throw err;
    }
  }

  private resolvePlayer(): NetflixSessionPlayer | null {
    try {
      const w = window as unknown as {
        netflix?: { appContext?: { state?: { playerApp?: { getAPI?: () => { videoPlayer?: NetflixVideoPlayerApi } } } } };
      };
      const api = w.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      if (!api?.getAllPlayerSessionIds || !api.getVideoPlayerBySessionId) return null;
      const ids = api.getAllPlayerSessionIds();
      const id = ids.find((s) => s.startsWith('watch-')) ?? ids[0];
      if (!id) return null;
      return api.getVideoPlayerBySessionId(id) ?? null;
    } catch {
      return null;
    }
  }

  private resolveVideo(): HTMLVideoElement | null {
    const current = document.querySelector('video');
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
    const next = readContentIdFromUrl();
    if (next === this.lastContentId) return;
    const previous = this.lastContentId;
    this.lastContentId = next;
    this.state.contentId = next;
    this.wasReady = false;
    this.emit({ type: 'contentchange', contentId: next, previous });
  }

  private poll(): void {
    this.health.polls++;
    this.lastPollAt = Date.now();
    this.checkContentChange();
    const player = this.resolvePlayer();
    const video = this.resolveVideo();
    this.health.apiFound = player !== null;

    let path: ControlPath = 'none';
    if (player) path = 'netflix-api';
    else if (video) path = 'video-element';
    this.health.path = path;

    if (!player && !video) {
      this.state = { ...EMPTY_PLAYER_STATE, contentId: this.lastContentId, sampledAtMs: Date.now() };
      this.emit({ type: 'state', state: this.getState() });
      return;
    }

    try {
      // The <video> element is the precise source of position: Netflix's
      // getCurrentTime() lags it by up to ~500ms between its own updates.
      const currentTimeMs = video
        ? video.currentTime * 1000
        : player?.getCurrentTime?.() ?? 0;
      const durationMs = player?.getDuration
        ? player.getDuration()
        : Number.isFinite(video?.duration) ? (video!.duration) * 1000 : 0;
      const playing = player?.isPlaying ? player.isPlaying() : !!video && !video.paused && !video.ended;
      const ready = player?.isReady ? player.isReady() : !!video && video.readyState >= 2;
      const ended = player?.isEnded ? player.isEnded() : !!video?.ended;
      const seeking = !!video?.seeking;
      const stalled = !!video && playing && !seeking && video.readyState < 3;
      const busy = player?.getBusy ? !!player.getBusy() : false;
      const buffering = (this.waiting || stalled || busy) && !ended;
      const playbackRate = video?.playbackRate ?? player?.getPlaybackRate?.() ?? 1;

      this.state = {
        contentId: this.lastContentId,
        currentTimeMs,
        durationMs,
        playing,
        buffering,
        seeking,
        ended,
        playbackRate,
        ready,
        sampledAtMs: Date.now(),
      };
      this.health.consecutiveReadErrors = 0;

      if (ready && !this.wasReady) {
        this.wasReady = true;
        this.emit({ type: 'ready' });
      }
      this.emit({ type: 'state', state: this.getState() });
    } catch (err) {
      this.health.consecutiveReadErrors++;
      this.fail('poll', err);
    }
  }
}
