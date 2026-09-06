import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/clock.js';

describe('ClockSync', () => {
  it('estimates offset from symmetric round trips', () => {
    const c = new ClockSync();
    // client clock is 500ms behind server; 40ms RTT
    c.addSample(1000, 1520, 1040);
    expect(c.offsetMs).toBe(500);
    expect(c.now(2000)).toBe(2500);
  });

  it('prefers low-RTT samples', () => {
    const c = new ClockSync();
    c.addSample(0, 700, 400); // noisy: 400ms rtt, offset 500
    c.addSample(1000, 1610, 1020); // 20ms rtt, offset 600
    c.addSample(2000, 2612, 2024); // 24ms rtt, offset 600
    c.addSample(3000, 3609, 3018); // 18ms rtt, offset 600
    c.addSample(4000, 4611, 4022); // 22ms rtt, offset 600
    c.addSample(5000, 5610, 5020); // 20ms rtt, offset 600
    expect(c.offsetMs).toBe(600);
    expect(c.bestRttMs).toBe(18);
  });
});
