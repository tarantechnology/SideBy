import type { PlayerState } from '@sideby/shared';

export type { PlayerState };

export interface ContentInfo {
  contentId: string | null;
  /** Series or film title as shown on screen, when available. */
  title?: string;
  /** Episode label ("S2:E4 The One Where…"), when available. */
  episode?: string;
  url: string;
}

export type ControlPath = 'netflix-api' | 'video-element' | 'none';

export interface AdapterHealth {
  path: ControlPath;
  apiFound: boolean;
  videoFound: boolean;
  attachedAtMs: number | null;
  polls: number;
  playCalls: number;
  pauseCalls: number;
  seekCalls: number;
  rateCalls: number;
  failedCalls: number;
  consecutiveReadErrors: number;
  lastError: string | null;
}

export type AdapterEvent =
  | { type: 'state'; state: PlayerState }
  | { type: 'contentchange'; contentId: string | null; previous: string | null }
  | { type: 'ready' }
  | { type: 'error'; message: string };

export type AdapterListener = (event: AdapterEvent) => void;

/**
 * The only thing the rest of Sideby knows about a streaming service.
 * Everything Netflix-specific stays behind this interface.
 */
export interface VideoAdapter {
  readonly service: string;
  getState(): PlayerState;
  getContentInfo(): ContentInfo;
  getHealth(): AdapterHealth;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(toMs: number): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  /** 0..1; also unmutes when raised above zero. */
  setVolume(volume: number): Promise<void>;
  on(listener: AdapterListener): () => void;
  destroy(): void;
}
