import { EMPTY_PLAYER_STATE, type PlayerState } from '@sideby/shared';
import type {
  AdapterEvent,
  AdapterHealth,
  AdapterListener,
  ContentInfo,
  VideoAdapter,
} from '../adapters/VideoAdapter.js';
import { BRIDGE_CHANNEL, isBridgeMessage, type BridgeMethod, type BridgeRequest } from './messages.js';

const REQUEST_TIMEOUT_MS = 4000;

/**
 * Isolated-world VideoAdapter that forwards to the MAIN-world adapter.
 * Keeps the latest state/health locally so reads are synchronous.
 */
export class AdapterProxy implements VideoAdapter {
  service = 'unknown';

  private listeners = new Set<AdapterListener>();
  private state: PlayerState = { ...EMPTY_PLAYER_STATE };
  private health: AdapterHealth = {
    path: 'none', apiFound: false, videoFound: false, attachedAtMs: null, polls: 0,
    playCalls: 0, pauseCalls: 0, seekCalls: 0, rateCalls: 0, failedCalls: 0,
    consecutiveReadErrors: 0, lastError: null,
  };
  private content: ContentInfo = { contentId: null, url: location.href };
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private onMessage = (ev: MessageEvent) => this.handle(ev);

  constructor() {
    window.addEventListener('message', this.onMessage);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getState(): PlayerState { return { ...this.state }; }
  getContentInfo(): ContentInfo { return { ...this.content }; }
  getHealth(): AdapterHealth { return { ...this.health }; }

  play(): Promise<void> { return this.call('play', []).then(() => undefined); }
  pause(): Promise<void> { return this.call('pause', []).then(() => undefined); }
  seek(toMs: number): Promise<void> { return this.call('seek', [toMs]).then(() => undefined); }
  setPlaybackRate(rate: number): Promise<void> { return this.call('setPlaybackRate', [rate]).then(() => undefined); }
  setVolume(volume: number): Promise<void> { return this.call('setVolume', [volume]).then(() => undefined); }

  /** Refresh health and content info from the MAIN world. */
  async refresh(): Promise<void> {
    const [health, content] = await Promise.all([
      this.call('getHealth', []) as Promise<AdapterHealth>,
      this.call('getContentInfo', []) as Promise<ContentInfo>,
    ]);
    this.health = health;
    this.content = content;
  }

  on(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    window.removeEventListener('message', this.onMessage);
    for (const p of this.pending.values()) { window.clearTimeout(p.timer); p.reject(new Error('destroyed')); }
    this.pending.clear();
    this.listeners.clear();
  }

  private call(method: BridgeMethod, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    const req: BridgeRequest = { channel: BRIDGE_CHANNEL, kind: 'req', id, method, args };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      window.postMessage(req, location.origin);
    });
  }

  private handle(ev: MessageEvent): void {
    if (ev.source !== window || !isBridgeMessage(ev.data)) return;
    const msg = ev.data;
    switch (msg.kind) {
      case 'hello':
        this.service = msg.service;
        this.state = msg.state;
        this.health = msg.health;
        this.content = msg.content;
        if (!this.connected) {
          this.connected = true;
          // Poke the MAIN world so it stops re-announcing.
          void this.refresh().catch(() => undefined);
        }
        break;
      case 'evt':
        this.connected = true;
        this.dispatch(msg.event);
        break;
      case 'res': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        window.clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error ?? 'adapter error'));
        break;
      }
    }
  }

  private dispatch(event: AdapterEvent): void {
    if (event.type === 'state') this.state = event.state;
    if (event.type === 'contentchange') this.content = { ...this.content, contentId: event.contentId, url: location.href };
    for (const l of this.listeners) {
      try { l(event); } catch (err) { console.warn('[sideby] listener threw', err); }
    }
  }
}
