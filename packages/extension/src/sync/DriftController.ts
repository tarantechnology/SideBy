import type { SyncConfig } from './config.js';

export type Correction =
  | { kind: 'none' }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek'; toMs: number };

/**
 * Decides how to correct a measured drift (actual - expected, in ms).
 * Positive drift means this player is ahead of the room.
 */
export class DriftController {
  private nudging = false;

  constructor(private readonly config: () => SyncConfig) {}

  get isNudging(): boolean {
    return this.nudging;
  }

  decide(driftMs: number): Correction {
    const c = this.config();
    const abs = Math.abs(driftMs);
    if (abs >= c.hardSeekMs) {
      this.nudging = false;
      return { kind: 'seek', toMs: -driftMs };
    }
    if (this.nudging) {
      if (abs <= c.settleMs) {
        this.nudging = false;
        return { kind: 'rate', rate: 1 };
      }
      return { kind: 'rate', rate: driftMs > 0 ? 1 - c.nudge : 1 + c.nudge };
    }
    if (abs >= c.deadbandMs) {
      this.nudging = true;
      return { kind: 'rate', rate: driftMs > 0 ? 1 - c.nudge : 1 + c.nudge };
    }
    return { kind: 'none' };
  }

  reset(): void {
    this.nudging = false;
  }
}
