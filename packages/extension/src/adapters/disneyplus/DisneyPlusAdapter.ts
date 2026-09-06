import { BaseVideoAdapter, type RawPlayerState } from '../BaseVideoAdapter.js';
import { DISNEYPLUS } from '../services.js';
import type { ContentInfo } from '../VideoAdapter.js';

/**
 * Disney+ (2026 player). Verified live on a title page:
 *
 * - `<disney-web-player>` carries the player: `.mediaPlayer` is the BAM
 *   media player API and `.mediaElement` the <video> that plays the title
 *   (currently `#hivePlayer1.hive-video`). A dormant
 *   `video.btm-media-client-element` sibling comes first in DOM order and
 *   never loads, so a plain `querySelector('video')` is wrong here.
 * - The element's clock is NOT the media position: after a seek the player
 *   rebuilds its source buffer and `video.currentTime` restarts near zero
 *   while `mediaPlayer.timeline.info.playheadPositionMs` keeps counting
 *   media time. Seeking through `video.currentTime` also clamps to the
 *   buffered range (duration is Infinity). So position, duration and seeks
 *   all go through the API, which takes and reports milliseconds.
 * - `mediaPlayer.playbackRate` only accepts the player's own presets;
 *   `video.playbackRate` accepts anything and sticks, so drift nudges use
 *   the element.
 * - `mediaPlayer.volume.level` is 0..100 and drives the element.
 * - `<disney-web-player-ui>.latestUiState.interstitials.isInterstitialPlaying`
 *   is true while an ad or promo plays instead of the title.
 *
 * Everything is optional so a player update degrades to the <video>
 * element instead of crashing.
 */

interface DisneyTimelineInfo {
  playheadPositionMs?: number;
  programDurationMs?: number;
  seekableEndMs?: number;
  forwardBufferDurationMs?: number;
}

interface DisneyPlaybackStatus {
  playing?: boolean;
  paused?: boolean;
  buffering?: boolean;
  ended?: boolean;
  notready?: boolean;
  /** "PLAYING" | "PAUSED" | "SEEKING" | "BUFFERING" | … */
  currentState?: string;
}

interface DisneyPlayerApi {
  timeline?: { info?: DisneyTimelineInfo };
  playbackStatus?: DisneyPlaybackStatus;
  playbackRate?: number;
  volume?: { level?: number; mute?: () => void; unmute?: () => void };
  play?: () => unknown;
  pause?: () => unknown;
  /** Media position in milliseconds. */
  seek?: (ms: number) => unknown;
}

interface DisneyPlayerElement extends HTMLElement {
  mediaPlayer?: DisneyPlayerApi;
  mediaElement?: HTMLMediaElement;
}

interface DisneyUiState {
  interstitials?: { isInterstitialPlaying?: boolean; isAdType?: boolean; isPromoType?: boolean; isSlateAd?: boolean };
  playback?: { seeking?: boolean; buffering?: boolean };
  volume?: { level?: number; muted?: boolean };
}

interface DisneyUiElement extends HTMLElement {
  latestUiState?: DisneyUiState;
}

const PLAYER_HOSTS = 'disney-web-player, .btm-media-client, [data-testid="disney-web-player-container"]';
const TITLE_OVERLAYS = ['title-overlay', '[data-testid="title-field"]', '.title-field'];
const EPISODE_OVERLAYS = ['[data-testid="subtitle-field"]', '.subtitle-field'];
/** Ad-supported plans: the badge overlay renders text only during a break. */
const AD_OVERLAYS = 'ad-badge-overlay, [data-testid="ad-badge"], [data-testid="ad-countdown"], .ad-badge';

function playerElement(): DisneyPlayerElement | null {
  return document.querySelector<DisneyPlayerElement>('disney-web-player');
}

function uiState(): DisneyUiState | undefined {
  return document.querySelector<DisneyUiElement>('disney-web-player-ui')?.latestUiState;
}

/** Text inside an element's shadow root (or the element) with whitespace collapsed. */
function overlayText(el: Element | null): string {
  if (!el) return '';
  const text = el.shadowRoot?.textContent ?? el.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

function firstOverlayText(selectors: string[]): string | undefined {
  for (const s of selectors) {
    const t = overlayText(document.querySelector(s));
    if (t) return t;
  }
  return undefined;
}

/** Fallback when the player element does not hand us its media element. */
function score(v: HTMLVideoElement): number {
  let s = 0;
  if (v.closest(PLAYER_HOSTS)) s += 2;
  if (/^hivePlayer/.test(v.id) || v.classList.contains('hive-video')) s += 2;
  if (v.classList.contains('btm-media-client-element')) s -= 1; // dormant sibling
  if (v.readyState > 0) s += 2;
  if (v.currentSrc || v.src) s += 1;
  if (!v.paused) s += 1;
  return s;
}

export class DisneyPlusAdapter extends BaseVideoAdapter<DisneyPlayerApi> {
  constructor() {
    super(DISNEYPLUS);
  }

  protected override resolveNative(): DisneyPlayerApi | null {
    try {
      const api = playerElement()?.mediaPlayer;
      if (!api?.timeline?.info || !api.playbackStatus) return null;
      return api;
    } catch {
      return null;
    }
  }

  protected override findVideo(): HTMLVideoElement | null {
    const owned = playerElement()?.mediaElement;
    if (owned instanceof HTMLVideoElement && owned.isConnected) return owned;
    const candidates = Array.from(document.querySelectorAll('video'));
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  }

  protected override readTitle(): Pick<ContentInfo, 'title' | 'episode'> {
    let title = firstOverlayText(TITLE_OVERLAYS);
    if (!title) {
      // "The Simpsons | Disney+" → "The Simpsons"
      const doc = document.title.replace(/\s*\|\s*Disney\+?\s*$/i, '').replace(/^Watch\s+/i, '').trim();
      title = doc && !/^Disney\+?$/i.test(doc) ? doc : undefined;
    }
    return { title, episode: firstOverlayText(EPISODE_OVERLAYS) };
  }

  protected override readState(api: DisneyPlayerApi | null, video: HTMLVideoElement | null): RawPlayerState {
    if (!api) return super.readState(null, video);
    const info = api.timeline?.info ?? {};
    const status = api.playbackStatus ?? {};
    const ui = uiState();
    const element = video ? super.readState(null, video) : null;

    const durationMs = info.programDurationMs ?? info.seekableEndMs ?? 0;
    const seeking = status.currentState === 'SEEKING' || !!ui?.playback?.seeking;
    const ended = !!status.ended;
    const playing = !!status.playing && !status.paused && !ended;
    // The player's own flag, or the element starving while the player says it is playing.
    const stalled = playing && !seeking && !!video && video.readyState < 3;
    const buffering = (!!status.buffering || !!ui?.playback?.buffering || (element?.buffering ?? false) || stalled) && !ended;
    return {
      currentTimeMs: info.playheadPositionMs ?? element?.currentTimeMs ?? 0,
      durationMs,
      playing,
      buffering,
      seeking,
      ended,
      playbackRate: element?.playbackRate ?? api.playbackRate ?? 1,
      volume: typeof api.volume?.level === 'number' ? api.volume.level / 100 : element?.volume ?? 1,
      muted: ui?.volume?.muted ?? element?.muted ?? false,
      ready: !status.notready && durationMs > 0,
    };
  }

  protected override doPlay(api: DisneyPlayerApi | null, video: HTMLVideoElement | null): unknown {
    if (api?.play) return api.play();
    return super.doPlay(null, video);
  }

  protected override doPause(api: DisneyPlayerApi | null, video: HTMLVideoElement | null): unknown {
    if (api?.pause) return api.pause();
    return super.doPause(null, video);
  }

  protected override doSeek(api: DisneyPlayerApi | null, video: HTMLVideoElement | null, toMs: number): unknown {
    if (api?.seek) return api.seek(toMs);
    return super.doSeek(null, video, toMs);
  }

  protected override doSetPlaybackRate(api: DisneyPlayerApi | null, video: HTMLVideoElement | null, rate: number): unknown {
    // The element accepts fractional nudges and keeps them; the API only takes presets.
    if (video) return super.doSetPlaybackRate(null, video, rate);
    if (api && 'playbackRate' in api) { api.playbackRate = rate; return undefined; }
    throw new Error('no player');
  }

  protected override doSetVolume(api: DisneyPlayerApi | null, video: HTMLVideoElement | null, v: number): unknown {
    if (!api?.volume && !video) throw new Error('no player');
    if (api?.volume) {
      api.volume.level = Math.round(v * 100);
      if (v > 0) api.volume.unmute?.();
    } else if (video) {
      super.doSetVolume(null, video, v);
    }
    return undefined;
  }

  protected override inAdBreak(video: HTMLVideoElement | null): boolean {
    const inter = uiState()?.interstitials;
    if (inter?.isInterstitialPlaying) return true;
    for (const el of document.querySelectorAll(AD_OVERLAYS)) {
      if (overlayText(el)) return true;
    }
    // A second element with media that is advancing while ours is not is an ad slot.
    if (video) {
      for (const other of document.querySelectorAll('video')) {
        if (other !== video && !other.paused && other.readyState > 0 && other.currentTime > 0) return true;
      }
    }
    return false;
  }
}
