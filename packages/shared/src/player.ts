/**
 * Service-agnostic snapshot of a video player. Produced by a VideoAdapter,
 * consumed by the sync engine and, later, sent to the room server.
 */
export interface PlayerState {
  /** Stable identity of the loaded title (Netflix: the numeric /watch/<id>). */
  contentId: string | null;
  currentTimeMs: number;
  durationMs: number;
  playing: boolean;
  buffering: boolean;
  seeking: boolean;
  ended: boolean;
  playbackRate: number;
  /** True once the underlying player can accept play/seek commands. */
  ready: boolean;
  /** Wall-clock (Date.now()) at which this snapshot was sampled. */
  sampledAtMs: number;
}

export const EMPTY_PLAYER_STATE: PlayerState = {
  contentId: null,
  currentTimeMs: 0,
  durationMs: 0,
  playing: false,
  buffering: false,
  seeking: false,
  ended: false,
  playbackRate: 1,
  ready: false,
  sampledAtMs: 0,
};
