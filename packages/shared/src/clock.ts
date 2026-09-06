/**
 * Estimates the offset between this client's clock and the server's using
 * NTP-style round trips. Keeps the lowest-RTT samples; their median is the
 * offset, because low-RTT samples have the least asymmetric-latency error.
 */
export interface ClockSample {
  offsetMs: number;
  rttMs: number;
  atMs: number;
}

const KEEP_BEST = 5;
const MAX_SAMPLES = 20;

export class ClockSync {
  private samples: ClockSample[] = [];

  /**
   * @param t0 client time when the ping was sent
   * @param serverMs server time stamped on the reply
   * @param t1 client time when the reply arrived
   */
  addSample(t0: number, serverMs: number, t1: number): ClockSample {
    const rttMs = Math.max(0, t1 - t0);
    const offsetMs = serverMs - (t0 + rttMs / 2);
    const sample = { offsetMs, rttMs, atMs: t1 };
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return sample;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** Server time minus client time. 0 until at least one sample exists. */
  get offsetMs(): number {
    if (this.samples.length === 0) return 0;
    const best = [...this.samples].sort((a, b) => a.rttMs - b.rttMs).slice(0, KEEP_BEST);
    const offsets = best.map((s) => s.offsetMs).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    return offsets.length % 2 === 1 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
  }

  get bestRttMs(): number {
    return this.samples.reduce((m, s) => Math.min(m, s.rttMs), Number.POSITIVE_INFINITY);
  }

  /** Estimated server time now. */
  now(clientNowMs: number = Date.now()): number {
    return clientNowMs + this.offsetMs;
  }

  toServer(clientMs: number): number {
    return clientMs + this.offsetMs;
  }

  toClient(serverMs: number): number {
    return serverMs - this.offsetMs;
  }

  reset(): void {
    this.samples = [];
  }
}
