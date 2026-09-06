import { applyIntent, createTimeline, freezeAt, resolveAt, resumeTogether, type ApplyResult, type IntentEnvelope, type RoomTimeline } from './timeline.js';

const SEEN_LIMIT = 512;
/** Delay before a held room resumes so every member has time to get the message. */
export const RESUME_DELAY_MS = 600;

/**
 * Owns one room's timeline and message de-duplication. Runs on the server
 * and inside the leader tab of the local transport. No I/O.
 */
export class RoomEngine {
  private tl: RoomTimeline;
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  constructor(contentId: string | null, serverNowMs: number, initial?: RoomTimeline) {
    this.tl = initial ?? createTimeline(contentId, serverNowMs);
  }

  get timeline(): RoomTimeline {
    return this.tl;
  }

  /** Replace state wholesale (leader handover, restore from store). */
  restore(tl: RoomTimeline): void {
    if (tl.revision >= this.tl.revision) this.tl = tl;
  }

  resolve(serverNowMs: number) {
    return resolveAt(this.tl, serverNowMs);
  }

  apply(env: IntentEnvelope, serverNowMs: number): ApplyResult {
    if (this.seen.has(env.msgId)) return { accepted: false, reason: 'duplicate', timeline: this.tl };
    this.remember(env.msgId);

    const wasHeld = this.tl.holds.length > 0;
    const result = applyIntent(this.tl, env, serverNowMs);
    if (!result.accepted) return result;

    let next = result.timeline;
    const isHeld = next.holds.length > 0;
    if (env.intent.kind === 'hold') {
      if (!wasHeld && isHeld && next.playing) {
        // First hold while playing: freeze everyone where the timeline was
        // (resolve against the pre-hold timeline; holds pin the anchor).
        const frozen = freezeAt(this.tl, serverNowMs);
        next = { ...next, anchorMediaMs: frozen.anchorMediaMs, anchorServerMs: serverNowMs, playAtServerMs: null };
      } else if (wasHeld && !isHeld && next.playing) {
        next = resumeTogether(next, serverNowMs, RESUME_DELAY_MS);
      }
    }
    this.tl = next;
    return { accepted: true, timeline: next };
  }

  /** A member left: drop any hold it had so the room does not stay frozen. */
  removeMember(memberId: string, serverNowMs: number): boolean {
    if (!this.tl.holds.includes(memberId)) return false;
    const holds = this.tl.holds.filter((m) => m !== memberId);
    let next: RoomTimeline = { ...this.tl, holds, revision: this.tl.revision + 1, updatedAtServerMs: serverNowMs };
    if (holds.length === 0 && next.playing) next = resumeTogether(next, serverNowMs, RESUME_DELAY_MS);
    this.tl = next;
    return true;
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }
}
