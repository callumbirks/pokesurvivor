import { describe, expect, it } from 'vitest';
import { TICK_MS, drainTicks } from './index.js';

describe('drainTicks', () => {
  it('consumes whole ticks and keeps the remainder', () => {
    const { ticks, remainderMs } = drainTicks(TICK_MS * 2.5);
    expect(ticks).toBe(2);
    expect(remainderMs).toBeCloseTo(TICK_MS / 2);
  });

  it('never returns negative ticks', () => {
    expect(drainTicks(-5).ticks).toBe(0);
  });
});
