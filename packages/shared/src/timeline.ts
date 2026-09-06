/**
 * The authoritative shared timeline for a room. Pure data + pure functions
 * so the same logic runs on the server and inside a leader tab locally.
 *
 * Position is defined by an anchor: at server time `anchorServerMs` the
 * media was at `anchorMediaMs`. While playing, position advances at `rate`.
 * A scheduled play keeps the anchor fixed until `playAtServerMs`, so every
 * member can start on the same server instant instead of on "play now".
 */
export interface RoomTimeline {
  contentId: string | null;
  revision: number;
  playing: boolean;
  anchorMediaMs: number;
  anchorServerMs: number;
  rate: number;
  /** When set, playback begins at this server time from anchorMediaMs. */
  playAtServerMs: number | null;
  /** Member ids currently holding playback (buffering). */
  holds: string[];
  updatedBy: string | null;
  updatedAtServerMs: number;
}

export interface ResolvedPlayback {
  playing: boolean;
  positionMs: number;
  /** ms until a scheduled play begins; 0 when none or already started. */
  startsInMs: number;
}

export function createTimeline(contentId: string | null, serverNowMs: number): RoomTimeline {
  return {
    contentId,
    revision: 0,
    playing: false,
    anchorMediaMs: 0,
    anchorServerMs: serverNowMs,
    rate: 1,
    playAtServerMs: null,
    holds: [],
    updatedBy: null,
    updatedAtServerMs: serverNowMs,
  };
}

/** Effective playing flag and media position at a given server time. */
export function resolveAt(tl: RoomTimeline, serverNowMs: number): ResolvedPlayback {
  // A hold (someone buffering) freezes everyone at the anchor; `playing`
  // then only records the intent to resume once the hold clears.
  if (tl.holds.length > 0) return { playing: false, positionMs: tl.anchorMediaMs, startsInMs: 0 };
  if (tl.playAtServerMs !== null) {
    if (serverNowMs < tl.playAtServerMs) {
      return { playing: false, positionMs: tl.anchorMediaMs, startsInMs: tl.playAtServerMs - serverNowMs };
    }
    return {
      playing: true,
      positionMs: tl.anchorMediaMs + (serverNowMs - tl.playAtServerMs) * tl.rate,
      startsInMs: 0,
    };
  }
  if (!tl.playing) return { playing: false, positionMs: tl.anchorMediaMs, startsInMs: 0 };
  return {
    playing: true,
    positionMs: tl.anchorMediaMs + (serverNowMs - tl.anchorServerMs) * tl.rate,
    startsInMs: 0,
  };
}

export type Intent =
  | { kind: 'play'; mediaMs: number }
  | { kind: 'pause'; mediaMs: number }
  | { kind: 'seek'; mediaMs: number; playing: boolean }
  | { kind: 'setContent'; contentId: string }
  | { kind: 'schedulePlay'; mediaMs: number; delayMs: number }
  | { kind: 'hold'; on: boolean };

export interface IntentEnvelope {
  msgId: string;
  memberId: string;
  /** Timeline revision the sender had seen when it acted. */
  baseRevision: number;
  /** Sender's estimate of server time when the action happened. */
  atServerMs: number;
  intent: Intent;
}

export interface ApplyResult {
  accepted: boolean;
  reason?: 'duplicate' | 'stale' | 'noop';
  timeline: RoomTimeline;
}

/** Intents built on a revision older than this many behind are dropped as stale. */
export const STALE_REVISION_WINDOW = 3;
/** How far in the past an intent's own timestamp may be before we clamp it. */
const MAX_INTENT_AGE_MS = 2000;

function clampAt(atServerMs: number, serverNowMs: number): number {
  if (!Number.isFinite(atServerMs)) return serverNowMs;
  return Math.min(serverNowMs, Math.max(serverNowMs - MAX_INTENT_AGE_MS, atServerMs));
}

/**
 * Applies one intent to a timeline. Pure: returns a new timeline.
 * Duplicate-msgId protection lives in RoomEngine, which owns the id set.
 */
export function applyIntent(tl: RoomTimeline, env: IntentEnvelope, serverNowMs: number): ApplyResult {
  if (env.baseRevision < tl.revision - STALE_REVISION_WINDOW) {
    return { accepted: false, reason: 'stale', timeline: tl };
  }
  const at = clampAt(env.atServerMs, serverNowMs);
  const base = { updatedBy: env.memberId, updatedAtServerMs: serverNowMs, revision: tl.revision + 1 };
  const i = env.intent;

  switch (i.kind) {
    case 'play':
      return { accepted: true, timeline: { ...tl, ...base, playing: true, anchorMediaMs: i.mediaMs, anchorServerMs: at, playAtServerMs: null } };
    case 'pause':
      return { accepted: true, timeline: { ...tl, ...base, playing: false, anchorMediaMs: i.mediaMs, anchorServerMs: at, playAtServerMs: null } };
    case 'seek':
      return { accepted: true, timeline: { ...tl, ...base, playing: i.playing, anchorMediaMs: i.mediaMs, anchorServerMs: at, playAtServerMs: null } };
    case 'setContent':
      if (tl.contentId === i.contentId) return { accepted: false, reason: 'noop', timeline: tl };
      return {
        accepted: true,
        timeline: { ...tl, ...base, contentId: i.contentId, playing: false, anchorMediaMs: 0, anchorServerMs: at, playAtServerMs: null, holds: [] },
      };
    case 'schedulePlay':
      return {
        accepted: true,
        timeline: { ...tl, ...base, playing: true, anchorMediaMs: i.mediaMs, anchorServerMs: at, playAtServerMs: serverNowMs + Math.max(0, i.delayMs) },
      };
    case 'hold': {
      const has = tl.holds.includes(env.memberId);
      if (i.on === has) return { accepted: false, reason: 'noop', timeline: tl };
      const holds = i.on ? [...tl.holds, env.memberId] : tl.holds.filter((m) => m !== env.memberId);
      return { accepted: true, timeline: { ...tl, ...base, holds } };
    }
  }
}

/**
 * Freezes a playing timeline at the current position (used when a hold
 * begins) or resumes it together after a short delay (when holds clear).
 */
export function freezeAt(tl: RoomTimeline, serverNowMs: number): RoomTimeline {
  const r = resolveAt(tl, serverNowMs);
  return { ...tl, revision: tl.revision + 1, anchorMediaMs: r.positionMs, anchorServerMs: serverNowMs, playAtServerMs: null, updatedAtServerMs: serverNowMs };
}

export function resumeTogether(tl: RoomTimeline, serverNowMs: number, delayMs: number): RoomTimeline {
  return { ...tl, revision: tl.revision + 1, playing: true, anchorServerMs: serverNowMs, playAtServerMs: serverNowMs + delayMs, updatedAtServerMs: serverNowMs };
}
