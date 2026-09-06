/** Tunable sync thresholds. Editable live from the debug panel. */
export interface SyncConfig {
  /** Drift below this is ignored. */
  deadbandMs: number;
  /** Drift at or above this is corrected with a hard seek. */
  hardSeekMs: number;
  /** Temporary playback-rate delta used to absorb moderate drift. */
  nudge: number;
  /** Stop nudging once drift falls below this. */
  settleMs: number;
  /** How often to evaluate drift. */
  tickMs: number;
  /** Position jump (beyond natural progress) that counts as a user seek. */
  userSeekJumpMs: number;
  /** After we issue a command, ignore matching adapter transitions this long. */
  echoWindowMs: number;
  /** Buffering must last this long before we hold the room for everyone. */
  holdDebounceMs: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  deadbandMs: 150,
  hardSeekMs: 2000,
  nudge: 0.02,
  settleMs: 40,
  tickMs: 1000,
  userSeekJumpMs: 1500,
  echoWindowMs: 1500,
  holdDebounceMs: 400,
};
