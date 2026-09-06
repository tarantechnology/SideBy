import { z } from 'zod';

/** Wire protocol between extension and room server (JSON over WebSocket). */

export const IntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play'), mediaMs: z.number().finite().min(0) }),
  z.object({ kind: z.literal('pause'), mediaMs: z.number().finite().min(0) }),
  z.object({ kind: z.literal('seek'), mediaMs: z.number().finite().min(0), playing: z.boolean() }),
  z.object({ kind: z.literal('setContent'), contentId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('schedulePlay'), mediaMs: z.number().finite().min(0), delayMs: z.number().finite().min(0).max(60_000) }),
  z.object({ kind: z.literal('hold'), on: z.boolean() }),
]);

export const IntentEnvelopeSchema = z.object({
  msgId: z.string().min(1).max(64),
  memberId: z.string().min(1).max(64),
  baseRevision: z.number().int().min(0),
  atServerMs: z.number().finite(),
  intent: IntentSchema,
});

export const ReadinessSchema = z.object({
  loggedIn: z.boolean(),
  contentMatch: z.boolean(),
  playerReady: z.boolean(),
  cameraReady: z.boolean(),
  /** True when this member has no player (hanging out); the friend sees it as such. */
  hangout: z.boolean().optional(),
});
export type Readiness = z.infer<typeof ReadinessSchema>;

/** Client → server */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('clock'), t0: z.number().finite() }),
  z.object({
    type: z.literal('join'),
    roomId: z.string().min(1).max(64),
    memberId: z.string().min(1).max(64),
    memberToken: z.string().min(1).max(128),
    contentId: z.string().max(64).nullable(),
    name: z.string().max(40).optional(),
  }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('intent'), env: IntentEnvelopeSchema }),
  z.object({ type: z.literal('readiness'), readiness: ReadinessSchema }),
  z.object({ type: z.literal('rtc'), to: z.string().min(1).max(64), payload: z.unknown() }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface WireMember {
  memberId: string;
  name?: string;
  connected: boolean;
  readiness: Readiness;
}

export interface WireTimeline {
  contentId: string | null;
  revision: number;
  playing: boolean;
  anchorMediaMs: number;
  anchorServerMs: number;
  rate: number;
  playAtServerMs: number | null;
  holds: string[];
  updatedBy: string | null;
  updatedAtServerMs: number;
}

/** Server → client */
export type ServerMessage =
  | { type: 'clock'; t0: number; serverMs: number }
  | { type: 'joined'; roomId: string; memberId: string; serverMs: number; iceServers: RTCIceServerLike[] }
  | { type: 'snapshot'; roomId: string; timeline: WireTimeline; members: WireMember[]; serverMs: number }
  | { type: 'rejected'; msgId: string; reason: string }
  | { type: 'rtc'; from: string; payload: unknown }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; serverMs: number };

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}
