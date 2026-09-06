import { BaseVideoAdapter, textOf } from '../BaseVideoAdapter.js';
import { HULU } from '../services.js';
import type { ContentInfo } from '../VideoAdapter.js';

/**
 * Hulu plays the title in a plain <video> element and its controls follow
 * element-level play/pause/seek. What sets Hulu apart is ads: on the
 * ad-supported plan a break can start at any chapter boundary and after a
 * seek, and while it runs the element describes the ad. The base adapter
 * freezes our reported state for the break so the room holds for us.
 */

/** Hulu's content element; older builds labelled it, newer ones wrap it. */
const VIDEO_SELECTORS = '#content-video-player, video[data-testid="content-video-player"], .PlayerContainer video, video';

const TITLE_SELECTORS = ['[data-testid="player-metadata-title"]', '.PlayerMetadata__title', '.player-metadata__title', '[data-automationid="player-title"]'];
const EPISODE_SELECTORS = ['[data-testid="player-metadata-subtitle"]', '.PlayerMetadata__subTitle', '.PlayerMetadata__subtitle', '.player-metadata__subtitle'];

/** Surfaces Hulu shows only during an ad break. */
const AD_SELECTORS = '.AdUnitView, [data-testid="ad-unit"], [data-testid="ad-badge"], [data-testid="ad-countdown"], .AdBadge, .ad-badge, [class*="AdUnit"], [class*="AdCountdown"], [class*="ad-countdown"]';

export class HuluAdapter extends BaseVideoAdapter {
  constructor() {
    super(HULU);
  }

  protected override findVideo(): HTMLVideoElement | null {
    // Prefer the element Hulu marks as content; otherwise the one that has media.
    const candidates = Array.from(document.querySelectorAll<HTMLVideoElement>(VIDEO_SELECTORS));
    if (candidates.length === 0) return null;
    const labelled = candidates.find((v) => v.id === 'content-video-player' || v.dataset.testid === 'content-video-player');
    if (labelled) return labelled;
    return candidates.find((v) => v.readyState > 0) ?? candidates[0] ?? null;
  }

  protected override readTitle(): Pick<ContentInfo, 'title' | 'episode'> {
    const first = (selectors: string[]) => {
      for (const s of selectors) {
        const t = textOf(s);
        if (t) return t;
      }
      return undefined;
    };
    let title = first(TITLE_SELECTORS);
    if (!title) {
      // "Watch <Title> Streaming Online | Hulu" → "<Title>"
      const doc = document.title
        .replace(/\s*\|\s*Hulu\s*$/i, '')
        .replace(/^Watch\s+/i, '')
        .replace(/\s+(Streaming\s+)?Online$/i, '')
        .trim();
      title = doc && !/^Hulu$/i.test(doc) ? doc : undefined;
    }
    return { title, episode: first(EPISODE_SELECTORS) };
  }

  protected override inAdBreak(video: HTMLVideoElement | null): boolean {
    if (document.querySelector(AD_SELECTORS)) return true;
    // Ads that play in a separate element leave the content element paused
    // while something else advances.
    if (video) {
      for (const other of document.querySelectorAll('video')) {
        if (other !== video && !other.paused && other.currentTime > 0) return true;
      }
    }
    return false;
  }
}
