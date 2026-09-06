import { describe, expect, it } from 'vitest';
import { RoomEngine, applyIntent, createTimeline, resolveAt, type IntentEnvelope } from '../src/index.js';

const env = (over: Partial<IntentEnvelope> & { intent: IntentEnvelope['intent'] }): IntentEnvelope => ({
  msgId: over.msgId ?? Math.random().toString(36),
  memberId: over.memberId ?? 'a',
  baseRevision: over.baseRevision ?? 0,
  atServerMs: over.atServerMs ?? 1000,
  intent: over.intent,
});

describe('resolveAt', () => {
  it('holds position while paused', () => {
    const tl = { ...createTimeline('x', 0), anchorMediaMs: 5000 };
    expect(resolveAt(tl, 10_000)).toEqual({ playing: false, positionMs: 5000, startsInMs: 0 });
  });

  it('advances while playing at rate', () => {
    const tl = { ...createTimeline('x', 0), playing: true, anchorMediaMs: 5000, anchorServerMs: 1000 };
    expect(resolveAt(tl, 3000).positionMs).toBe(7000);
  });

  it('waits for a scheduled play, then advances from the scheduled instant', () => {
    const tl = { ...createTimeline('x', 0), playing: true, anchorMediaMs: 0, anchorServerMs: 0, playAtServerMs: 3000 };
    expect(resolveAt(tl, 2000)).toEqual({ playing: false, positionMs: 0, startsInMs: 1000 });
    expect(resolveAt(tl, 4500)).toEqual({ playing: true, positionMs: 1500, startsInMs: 0 });
  });
});

describe('applyIntent', () => {
  it('play anchors at the sender-reported time, compensating for latency', () => {
    const tl = createTimeline('x', 0);
    const r = applyIntent(tl, env({ intent: { kind: 'play', mediaMs: 10_000 }, atServerMs: 900 }), 1000);
    expect(r.accepted).toBe(true);
    expect(r.timeline.revision).toBe(1);
    // 100ms of latency: by server time 1000 the sender is already at 10_100.
    expect(resolveAt(r.timeline, 1000).positionMs).toBe(10_100);
  });

  it('clamps intent timestamps that are implausibly old or in the future', () => {
    const tl = createTimeline('x', 0);
    const old = applyIntent(tl, env({ intent: { kind: 'play', mediaMs: 0 }, atServerMs: -50_000 }), 10_000);
    expect(old.timeline.anchorServerMs).toBe(8000);
    const future = applyIntent(tl, env({ intent: { kind: 'play', mediaMs: 0 }, atServerMs: 99_999 }), 10_000);
    expect(future.timeline.anchorServerMs).toBe(10_000);
  });

  it('rejects intents based on a revision far behind', () => {
    const tl = { ...createTimeline('x', 0), revision: 10 };
    const r = applyIntent(tl, env({ intent: { kind: 'pause', mediaMs: 1 }, baseRevision: 2 }), 1000);
    expect(r).toMatchObject({ accepted: false, reason: 'stale' });
    const ok = applyIntent(tl, env({ intent: { kind: 'pause', mediaMs: 1 }, baseRevision: 8 }), 1000);
    expect(ok.accepted).toBe(true);
  });

  it('setContent resets playback and is a noop for the same id', () => {
    const tl = { ...createTimeline('x', 0), playing: true, anchorMediaMs: 500 };
    expect(applyIntent(tl, env({ intent: { kind: 'setContent', contentId: 'x' } }), 1).accepted).toBe(false);
    const r = applyIntent(tl, env({ intent: { kind: 'setContent', contentId: 'y' } }), 1);
    expect(r.timeline).toMatchObject({ contentId: 'y', playing: false, anchorMediaMs: 0 });
  });
});

describe('RoomEngine', () => {
  it('drops duplicate message ids', () => {
    const room = new RoomEngine('x', 0);
    const e = env({ msgId: 'same', intent: { kind: 'play', mediaMs: 0 } });
    expect(room.apply(e, 1000).accepted).toBe(true);
    expect(room.apply(e, 1001)).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(room.timeline.revision).toBe(1);
  });

  it('freezes on first hold and resumes together when holds clear', () => {
    const room = new RoomEngine('x', 0);
    room.apply(env({ intent: { kind: 'play', mediaMs: 0 }, atServerMs: 0 }), 0);
    room.apply(env({ memberId: 'b', intent: { kind: 'hold', on: true }, baseRevision: 1 }), 5000);
    expect(room.resolve(6000)).toMatchObject({ playing: false, positionMs: 5000 });
    room.apply(env({ memberId: 'b', intent: { kind: 'hold', on: false }, baseRevision: 2 }), 8000);
    const tl = room.timeline;
    expect(tl.holds).toEqual([]);
    expect(tl.playAtServerMs).toBeGreaterThan(8000);
    expect(room.resolve(8000)).toMatchObject({ playing: false, positionMs: 5000 });
    expect(room.resolve(tl.playAtServerMs! + 1000).positionMs).toBe(6000);
  });

  it('clears a departing member\'s hold', () => {
    const room = new RoomEngine('x', 0);
    room.apply(env({ intent: { kind: 'play', mediaMs: 0 }, atServerMs: 0 }), 0);
    room.apply(env({ memberId: 'b', intent: { kind: 'hold', on: true }, baseRevision: 1 }), 1000);
    expect(room.removeMember('b', 2000)).toBe(true);
    expect(room.timeline.holds).toEqual([]);
  });
});
