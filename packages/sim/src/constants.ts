/** Fixed simulation rate (§2.2 of the rebuild plan). */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
/** Seconds per tick: every system advances by exactly this much. */
export const DT = 1 / TICK_HZ;

/**
 * The world area one player sees (legacy camera: 768 world units wide, at least 420 tall; on a
 * 16:9 screen that's 768 × 432). The sim uses it for "off screen" rules: enemies spawn just outside
 * it, stragglers out of everyone's view come back ahead, projectiles far outside it are dropped.
 */
export const VIEW_W = 768;
export const VIEW_H = 432;
/** Radius of the circle around the view (legacy `Camera.outerRadius()`). */
export const OUTER_RADIUS = Math.hypot(VIEW_W, VIEW_H) / 2 + 40;

/** World units per tile, tiles per chunk, world units per chunk. */
export const TILE = 32;
export const CHUNK_TILES = 16;
export const CHUNK = TILE * CHUNK_TILES;

/** Seconds per biome before the map's palette (and liquid) changes. */
export const BIOME_SECONDS = 240;

/** Converts seconds to whole ticks. */
export const ticks = (seconds: number): number => Math.round(seconds * TICK_HZ);

/**
 * Fixed-timestep accumulator: how many whole ticks fit in `accumulatorMs`,
 * and what is left over for the next frame.
 */
export function drainTicks(accumulatorMs: number): { ticks: number; remainderMs: number } {
  const n = Math.max(0, Math.floor(accumulatorMs / TICK_MS));
  return { ticks: n, remainderMs: accumulatorMs - n * TICK_MS };
}
