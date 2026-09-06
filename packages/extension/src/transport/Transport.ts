import type { IntentEnvelope, Readiness, RoomTimeline } from '@sideby/shared';

export type TransportStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface MemberInfo {
  memberId: string;
  name?: string;
  connected: boolean;
  readiness?: Readiness;
}

export interface RoomSnapshot {
  roomId: string;
  timeline: RoomTimeline;
  members: MemberInfo[];
  /** Server time at which this snapshot was produced. */
  serverNowMs: number;
}

export type TransportEvent =
  | { type: 'status'; status: TransportStatus; detail?: string }
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | { type: 'rejected'; msgId: string; reason: string }
  | { type: 'rtc'; from: string; payload: unknown }
  | { type: 'ice'; iceServers: RTCIceServer[] };

/**
 * Carries intents to the room authority and authoritative snapshots back.
 * Implementations own clock synchronization so callers can ask serverNow().
 */
export interface Transport {
  readonly kind: 'local' | 'ws';
  readonly memberId: string;
  readonly status: TransportStatus;
  join(roomId: string, contentId: string | null): Promise<void>;
  leave(): void;
  send(env: IntentEnvelope): void;
  /** Estimated server time now. */
  serverNow(): number;
  /** Round-trip estimate to the authority, for latency-aware corrections. */
  rttMs(): number;
  /** Report this member's preflight state (no-op for transports without members). */
  sendReadiness(readiness: Readiness): void;
  /** WebRTC signaling relay to another member. */
  sendRtc(to: string, payload: unknown): void;
  on(listener: (event: TransportEvent) => void): () => void;
}
