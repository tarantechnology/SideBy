import type { AdapterEvent, AdapterHealth, ContentInfo, PlayerState } from '../adapters/VideoAdapter.js';

/** Namespace on every window.postMessage payload so page scripts can ignore us. */
export const BRIDGE_CHANNEL = 'sideby/adapter/v1';

export type BridgeMethod = 'play' | 'pause' | 'seek' | 'setPlaybackRate' | 'getState' | 'getContentInfo' | 'getHealth';

export interface BridgeRequest {
  channel: typeof BRIDGE_CHANNEL;
  kind: 'req';
  id: number;
  method: BridgeMethod;
  args: unknown[];
}

export interface BridgeResponse {
  channel: typeof BRIDGE_CHANNEL;
  kind: 'res';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface BridgeEvent {
  channel: typeof BRIDGE_CHANNEL;
  kind: 'evt';
  event: AdapterEvent;
}

export interface BridgeHello {
  channel: typeof BRIDGE_CHANNEL;
  kind: 'hello';
  service: string;
  state: PlayerState;
  health: AdapterHealth;
  content: ContentInfo;
}

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent | BridgeHello;

export function isBridgeMessage(data: unknown): data is BridgeMessage {
  return typeof data === 'object' && data !== null && (data as { channel?: unknown }).channel === BRIDGE_CHANNEL;
}
