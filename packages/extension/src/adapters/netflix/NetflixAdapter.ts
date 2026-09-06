import { BaseVideoAdapter, textOf, type RawPlayerState } from '../BaseVideoAdapter.js';
import { NETFLIX } from '../services.js';
import type { ContentInfo } from '../VideoAdapter.js';

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
  getVolume?: () => number;
  setVolume?: (volume: number) => void;
  setMuted?: (muted: boolean) => void;
}

interface NetflixVideoPlayerApi {
  getAllPlayerSessionIds?: () => string[];
  getVideoPlayerBySessionId?: (id: string) => NetflixSessionPlayer | undefined;
}

/**
 * Observes and controls the Netflix player without touching its media
 * pipeline. Prefers Netflix's own player API (which drives its UI and
 * seek logic correctly); falls back to the raw <video> element.
 */
export class NetflixAdapter extends BaseVideoAdapter<NetflixSessionPlayer> {
  constructor() {
    super(NETFLIX);
  }

  protected override resolveNative(): NetflixSessionPlayer | null {
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

  protected override readTitle(): Pick<ContentInfo, 'title' | 'episode'> {
    return {
      title: textOf('[data-uia="video-title"] h4') ?? textOf('[data-uia="video-title"]'),
      episode: textOf('[data-uia="video-title"] span'),
    };
  }

  protected override readState(player: NetflixSessionPlayer | null, video: HTMLVideoElement | null): RawPlayerState {
    if (!player && !video) throw new Error('no player');
    const element = video ? super.readState(null, video) : null;
    // The <video> element is the precise source of position: Netflix's
    // getCurrentTime() lags it by up to ~500ms between its own updates.
    const currentTimeMs = element ? element.currentTimeMs : player?.getCurrentTime?.() ?? 0;
    const durationMs = player?.getDuration ? player.getDuration() : element?.durationMs ?? 0;
    const playing = player?.isPlaying ? player.isPlaying() : element?.playing ?? false;
    const ready = player?.isReady ? player.isReady() : element?.ready ?? false;
    const ended = player?.isEnded ? player.isEnded() : element?.ended ?? false;
    const seeking = element?.seeking ?? false;
    const stalled = !!video && playing && !seeking && video.readyState < 3;
    const busy = player?.getBusy ? !!player.getBusy() : false;
    const waiting = element?.buffering ?? false;
    return {
      currentTimeMs,
      durationMs,
      playing,
      buffering: (waiting || stalled || busy) && !ended,
      seeking,
      ended,
      playbackRate: element?.playbackRate ?? player?.getPlaybackRate?.() ?? 1,
      volume: element?.volume ?? player?.getVolume?.() ?? 1,
      muted: element?.muted ?? false,
      ready,
    };
  }

  protected override doPlay(player: NetflixSessionPlayer | null, video: HTMLVideoElement | null): unknown {
    if (player?.play) return player.play();
    return super.doPlay(null, video);
  }

  protected override doPause(player: NetflixSessionPlayer | null, video: HTMLVideoElement | null): unknown {
    if (player?.pause) return player.pause();
    return super.doPause(null, video);
  }

  protected override doSeek(player: NetflixSessionPlayer | null, video: HTMLVideoElement | null, toMs: number): unknown {
    if (player?.seek) return player.seek(toMs);
    return super.doSeek(null, video, toMs);
  }

  protected override doSetPlaybackRate(player: NetflixSessionPlayer | null, video: HTMLVideoElement | null, rate: number): unknown {
    // The <video> element is authoritative for rate: Netflix's own speed
    // control ultimately sets video.playbackRate too.
    if (video) return super.doSetPlaybackRate(null, video, rate);
    if (player?.setPlaybackRate) return player.setPlaybackRate(rate);
    throw new Error('no player');
  }

  protected override doSetVolume(player: NetflixSessionPlayer | null, video: HTMLVideoElement | null, v: number): unknown {
    if (!player && !video) throw new Error('no player');
    // Netflix's API keeps its own volume UI in step; the element is the fallback.
    if (player?.setVolume) player.setVolume(v);
    if (video) video.volume = v;
    if (v > 0) {
      if (player?.setMuted) player.setMuted(false);
      else if (video) video.muted = false;
    }
    return undefined;
  }
}
