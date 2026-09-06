import { ClockSync, type IntentEnvelope, type Readiness, type ServerMessage } from '@sideby/shared';
import type { MemberInfo, Transport, TransportEvent, TransportStatus } from './Transport.js';

const CLOCK_BURST = 4;
const CLOCK_BURST_GAP_MS = 150;
const CLOCK_PERIOD_MS = 10_000;
const PING_PERIOD_MS = 20_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;
/** Server errors after which reconnecting would be pointless. */
const FATAL_CODES = new Set(['replaced', 'room_full', 'member_token']);

/**
 * WebSocket transport to the Sideby room server. Reconnects with backoff,
 * re-joins the room, and keeps a running clock-offset estimate so callers
 * can reason in server time.
 */
export class WsTransport implements Transport {
  readonly kind = 'ws' as const;
  readonly memberId: string;
  status: TransportStatus = 'idle';

  private readonly clock = new ClockSync();
  private socket: WebSocket | null = null;
  private roomId: string | null = null;
  private contentId: string | null = null;
  private wantConnected = false;
  private backoffMs = BACKOFF_MIN_MS;
  private reconnectTimer: number | null = null;
  private clockTimer: number | null = null;
  private pingTimer: number | null = null;
  private listeners = new Set<(e: TransportEvent) => void>();
  private joinedResolve: (() => void) | null = null;

  constructor(
    private readonly url: string,
    memberId: string,
    private readonly memberToken: string,
    private readonly name?: string,
  ) {
    this.memberId = memberId;
  }

  get offsetMs(): number {
    return this.clock.offsetMs;
  }

  async join(roomId: string, contentId: string | null): Promise<void> {
    this.roomId = roomId;
    this.contentId = contentId;
    this.wantConnected = true;
    this.backoffMs = BACKOFF_MIN_MS;
    const joined = new Promise<void>((resolve) => { this.joinedResolve = resolve; });
    if (this.socket?.readyState === WebSocket.OPEN) this.sendJoin();
    else this.open();
    // Do not block callers forever if the server is unreachable.
    await Promise.race([joined, new Promise<void>((r) => window.setTimeout(r, 4000))]);
  }

  leave(): void {
    this.wantConnected = false;
    if (this.socket?.readyState === WebSocket.OPEN) this.socketSend({ type: 'leave' });
    this.roomId = null;
    this.teardown();
    this.setStatus('closed');
  }

  send(env: IntentEnvelope): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.roomId) {
      this.emit({ type: 'rejected', msgId: env.msgId, reason: 'offline' });
      return;
    }
    this.socketSend({ type: 'intent', env });
  }

  sendReadiness(readiness: Readiness): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.roomId) this.socketSend({ type: 'readiness', readiness });
  }

  sendRtc(to: string, payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.roomId) this.socketSend({ type: 'rtc', to, payload });
  }

  serverNow(): number {
    return this.clock.now();
  }

  rttMs(): number {
    const best = this.clock.bestRttMs;
    return Number.isFinite(best) ? best : 100;
  }

  on(listener: (e: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------ internals

  private emit(e: TransportEvent): void {
    for (const l of this.listeners) l(e);
  }

  private setStatus(status: TransportStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.emit({ type: 'status', status, detail });
  }

  private socketSend(msg: unknown): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private open(): void {
    this.teardown();
    this.setStatus(this.backoffMs === BACKOFF_MIN_MS ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect(String(err));
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = BACKOFF_MIN_MS;
      void this.clockBurst().then(() => { if (this.socket === socket && this.roomId) this.sendJoin(); });
      this.clockTimer = window.setInterval(() => this.socketSend({ type: 'clock', t0: Date.now() }), CLOCK_PERIOD_MS);
      this.pingTimer = window.setInterval(() => this.socketSend({ type: 'ping' }), PING_PERIOD_MS);
    };
    socket.onmessage = (ev) => this.receive(ev.data as string);
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect(`closed ${ev.code}`);
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  private async clockBurst(): Promise<void> {
    for (let i = 0; i < CLOCK_BURST; i++) {
      this.socketSend({ type: 'clock', t0: Date.now() });
      await new Promise((r) => window.setTimeout(r, CLOCK_BURST_GAP_MS));
    }
  }

  private sendJoin(): void {
    if (!this.roomId) return;
    this.socketSend({ type: 'join', roomId: this.roomId, memberId: this.memberId, memberToken: this.memberToken, contentId: this.contentId, name: this.name });
  }

  private scheduleReconnect(detail: string): void {
    this.clearTimers();
    if (!this.wantConnected) return;
    this.setStatus('reconnecting', detail);
    this.reconnectTimer = window.setTimeout(() => this.open(), this.backoffMs);
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
  }

  private clearTimers(): void {
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.clockTimer = this.pingTimer = this.reconnectTimer = null;
  }

  private teardown(): void {
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) { s.onclose = null; s.onmessage = null; s.close(); }
  }

  private receive(raw: string): void {
    let msg: ServerMessage;
    try { msg = JSON.parse(raw) as ServerMessage; } catch { return; }
    switch (msg.type) {
      case 'clock':
        this.clock.addSample(msg.t0, msg.serverMs, Date.now());
        break;
      case 'pong':
        break;
      case 'joined':
        this.setStatus('connected');
        this.emit({ type: 'ice', iceServers: msg.iceServers as RTCIceServer[] });
        this.joinedResolve?.();
        this.joinedResolve = null;
        break;
      case 'snapshot': {
        const members: MemberInfo[] = msg.members.map((m) => ({ memberId: m.memberId, name: m.name, connected: m.connected, readiness: m.readiness }));
        this.emit({ type: 'snapshot', snapshot: { roomId: msg.roomId, timeline: msg.timeline, members, serverNowMs: msg.serverMs } });
        break;
      }
      case 'rejected':
        this.emit({ type: 'rejected', msgId: msg.msgId, reason: msg.reason });
        break;
      case 'rtc':
        this.emit({ type: 'rtc', from: msg.from, payload: msg.payload });
        break;
      case 'error':
        if (FATAL_CODES.has(msg.code)) {
          this.wantConnected = false;
          this.teardown();
          this.setStatus('closed', msg.message);
        } else {
          console.warn('[sideby] server error', msg.code, msg.message);
        }
        break;
    }
  }
}
