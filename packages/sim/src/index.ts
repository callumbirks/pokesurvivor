/** Fixed simulation rate (§2.2 of the rebuild plan). */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * Fixed-timestep accumulator: how many whole ticks fit in `accumulatorMs`,
 * and what is left over for the next frame.
 */
export function drainTicks(accumulatorMs: number): { ticks: number; remainderMs: number } {
  const ticks = Math.max(0, Math.floor(accumulatorMs / TICK_MS));
  return { ticks, remainderMs: accumulatorMs - ticks * TICK_MS };
}
