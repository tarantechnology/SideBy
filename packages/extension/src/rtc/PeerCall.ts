import type { Transport, TransportEvent } from '../transport/Transport.js';

export type CallStatus = 'idle' | 'no-peer' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type MediaStatus = 'off' | 'requesting' | 'on' | 'denied' | 'unavailable';

export interface CallSnapshot {
  status: CallStatus;
  media: MediaStatus;
  micOn: boolean;
  camOn: boolean;
  peerId: string | null;
  remoteHasVideo: boolean;
  remoteHasAudio: boolean;
  /** 0..1 applied to the friend's audio. */
  remoteVolume: number;
  error: string | null;
}

type Signal =
  | { kind: 'description'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit | null };

const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * One peer-to-peer camera/mic call with the other room member, signaled
 * over the room transport. Implements "perfect negotiation" so either side
 * can (re)negotiate at any time without glare. Sync never depends on this.
 */
export class PeerCall {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream = new MediaStream();
  private peerId: string | null = null;
  private iceServers: RTCIceServer[] = DEFAULT_ICE;
  private polite = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private status: CallStatus = 'idle';
  private media: MediaStatus = 'off';
  private micOn = true;
  private camOn = true;
  private error: string | null = null;
  private remoteVolume = 1;
  private offTransport: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private cache: CallSnapshot | null = null;
  private restartTimer: number | null = null;

  constructor(private readonly transport: Transport) {}

  /** Attach to transport events; call once. */
  start(): void {
    this.offTransport?.();
    this.offTransport = this.transport.on((ev) => this.onTransport(ev));
  }

  stop(): void {
    this.offTransport?.();
    this.offTransport = null;
    this.setPeer(null);
    this.stopMedia();
    this.status = 'idle';
    this.invalidate();
  }

  getRemoteStream(): MediaStream {
    return this.remoteStream;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CallSnapshot {
    if (this.cache) return this.cache;
    this.cache = {
      status: this.status,
      media: this.media,
      micOn: this.micOn,
      camOn: this.camOn,
      peerId: this.peerId,
      remoteHasVideo: this.remoteStream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted),
      remoteHasAudio: this.remoteStream.getAudioTracks().length > 0,
      remoteVolume: this.remoteVolume,
      error: this.error,
    };
    return this.cache;
  }

  /** Ask for camera + mic. Failure is reported, never thrown to sync. */
  async enableMedia(): Promise<void> {
    if (this.media === 'on' || this.media === 'requesting') return;
    this.media = 'requesting';
    this.invalidate();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.localStream = stream;
      this.media = 'on';
      this.applyTrackState();
      this.attachLocalTracks();
    } catch (err) {
      const name = (err as { name?: string }).name;
      this.media = name === 'NotAllowedError' ? 'denied' : 'unavailable';
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.invalidate();
  }

  disableMedia(): void {
    this.stopMedia();
    this.invalidate();
  }

  setRemoteVolume(volume: number): void {
    this.remoteVolume = Math.max(0, Math.min(1, volume));
    this.invalidate();
  }

  toggleMic(): void {
    this.micOn = !this.micOn;
    this.applyTrackState();
    this.invalidate();
  }

  toggleCam(): void {
    this.camOn = !this.camOn;
    this.applyTrackState();
    this.invalidate();
  }

  // ------------------------------------------------------------ internals

  private invalidate(): void {
    this.cache = null;
    for (const l of this.listeners) l();
  }

  private onTransport(ev: TransportEvent): void {
    switch (ev.type) {
      case 'ice':
        if (ev.iceServers.length) this.iceServers = ev.iceServers;
        break;
      case 'snapshot': {
        const peer = ev.snapshot.members.find((m) => m.memberId !== this.transport.memberId);
        this.setPeer(peer?.connected ? peer.memberId : null);
        break;
      }
      case 'rtc':
        if (ev.from === this.peerId) void this.onSignal(ev.payload as Signal);
        break;
      case 'status':
        if (ev.status === 'closed') this.setPeer(null);
        break;
    }
  }

  private setPeer(peerId: string | null): void {
    if (peerId === this.peerId) return;
    this.teardownPc();
    this.peerId = peerId;
    if (!peerId) {
      this.status = 'no-peer';
      this.invalidate();
      return;
    }
    // Deterministic roles: the lexically larger id yields on glare.
    this.polite = this.transport.memberId > peerId;
    this.status = 'connecting';
    this.createPc();
    this.invalidate();
  }

  private createPc(): void {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    // Always negotiate both directions so the remote can add camera later.
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    this.attachLocalTracks();

    pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      track.onmute = () => this.invalidate();
      track.onunmute = () => this.invalidate();
      track.onended = () => { this.remoteStream.removeTrack(track); this.invalidate(); };
      this.invalidate();
    };
    pc.onicecandidate = ({ candidate }) => this.signal({ kind: 'candidate', candidate: candidate ? candidate.toJSON() : null });
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.signal({ kind: 'description', description: pc.localDescription.toJSON() });
      } catch (err) {
        this.error = String(err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { this.status = 'connected'; this.error = null; }
      else if (s === 'disconnected') this.status = 'reconnecting';
      else if (s === 'failed') { this.status = 'failed'; this.scheduleIceRestart(); }
      this.invalidate();
    };
  }

  private scheduleIceRestart(): void {
    if (this.restartTimer !== null) return;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      const pc = this.pc;
      if (!pc || !this.peerId) return;
      if (pc.connectionState === 'failed') {
        this.status = 'reconnecting';
        pc.restartIce();
        this.invalidate();
      }
    }, 1500);
  }

  private teardownPc(): void {
    if (this.restartTimer !== null) { window.clearTimeout(this.restartTimer); this.restartTimer = null; }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null;
      pc.close();
    }
    for (const t of this.remoteStream.getTracks()) this.remoteStream.removeTrack(t);
    this.makingOffer = false;
    this.ignoreOffer = false;
  }

  private signal(payload: Signal): void {
    if (this.peerId) this.transport.sendRtc(this.peerId, payload);
  }

  private async onSignal(msg: Signal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (msg.kind === 'description') {
        const desc = msg.description;
        const offerCollision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this.signal({ kind: 'description', description: pc.localDescription.toJSON() });
        }
      } else if (msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.error = String(err);
      this.invalidate();
    }
  }

  private attachLocalTracks(): void {
    const pc = this.pc;
    const stream = this.localStream;
    if (!pc || !stream) return;
    for (const track of stream.getTracks()) {
      const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === track.kind);
      if (transceiver && transceiver.sender.track !== track) void transceiver.sender.replaceTrack(track);
    }
  }

  private applyTrackState(): void {
    if (!this.localStream) return;
    for (const t of this.localStream.getAudioTracks()) t.enabled = this.micOn;
    for (const t of this.localStream.getVideoTracks()) t.enabled = this.camOn;
  }

  private stopMedia(): void {
    if (this.localStream) for (const t of this.localStream.getTracks()) t.stop();
    this.localStream = null;
    this.media = 'off';
    if (this.pc) for (const tr of this.pc.getTransceivers()) void tr.sender.replaceTrack(null);
  }
}
