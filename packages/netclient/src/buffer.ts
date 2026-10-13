// Snapshot buffer and interpolation: the renderer draws the world ~100 ms in the past, between
// the two snapshots around that moment, so movement stays smooth at 15–20 snapshots per second
// and through some jitter. The server tick is mapped to local time from snapshot arrivals.
import { TICK_MS } from '@pokesurvivor/sim';
import type { NetEnemy, NetPlayer, NetProjectile, Snapshot } from './snapshot.js';

export interface SnapshotBufferOptions {
  /** How far behind the newest data to render. */
  delayMs?: number;
  /** Snapshots kept. */
  capacity?: number;
}

export interface BufferSample {
  from: Snapshot;
  to: Snapshot;
  /** 0 at `from`, 1 at `to`. */
  alpha: number;
  /** The (fractional) server tick being shown. */
  tick: number;
}

/** Arrival jitter beyond this resyncs the clock instead of smoothing it. */
const RESYNC_MS = 400;

export class SnapshotBuffer {
  readonly delayMs: number;
  private readonly capacity: number;
  private snaps: Snapshot[] = [];
  /** server tick time (ms) − local time (ms), smoothed. */
  private offset: number | null = null;

  constructor(opts: SnapshotBufferOptions = {}) {
    this.delayMs = opts.delayMs ?? 100;
    this.capacity = opts.capacity ?? 32;
  }

  get latest(): Snapshot | null {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  get size(): number {
    return this.snaps.length;
  }

  clear(): void {
    this.snaps = [];
    this.offset = null;
  }

  push(snap: Snapshot, receivedAt: number): void {
    if (snap.full) this.snaps = [];
    const last = this.latest;
    if (last && snap.tick < last.tick) return;
    this.snaps.push(snap);
    if (this.snaps.length > this.capacity) this.snaps.shift();
    const sample = snap.tick * TICK_MS - receivedAt;
    if (this.offset === null || snap.full || Math.abs(sample - this.offset) > RESYNC_MS)
      this.offset = sample;
    // Late arrivals pull the estimate down slowly; early ones (less delay) quickly.
    else this.offset += (sample - this.offset) * (sample > this.offset ? 0.25 : 0.05);
  }

  /** The server tick to render at local time `now`. */
  renderTick(now: number): number | null {
    if (this.offset === null) return null;
    return (now + this.offset - this.delayMs) / TICK_MS;
  }

  /** The two snapshots around the render time (clamped to the oldest/newest). */
  sample(now: number): BufferSample | null {
    const tick = this.renderTick(now);
    const first = this.snaps[0];
    const last = this.latest;
    if (tick === null || !first || !last) return null;
    if (tick <= first.tick) return { from: first, to: first, alpha: 0, tick: first.tick };
    if (tick >= last.tick) return { from: last, to: last, alpha: 0, tick: last.tick };
    for (let i = this.snaps.length - 1; i > 0; i--) {
      const from = this.snaps[i - 1] as Snapshot;
      const to = this.snaps[i] as Snapshot;
      if (tick >= from.tick) {
        const span = to.tick - from.tick;
        return { from, to, alpha: span > 0 ? (tick - from.tick) / span : 1, tick };
      }
    }
    return { from: first, to: first, alpha: 0, tick: first.tick };
  }
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolates angles the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

interface Positioned {
  id: number | string;
  x: number;
  y: number;
}

/**
 * Entities of `to`, moved to their interpolated position. Ones that only exist in `to` are drawn
 * where they are; ones only in `from` are gone.
 */
export function interpolateList<E extends Positioned>(
  from: readonly E[],
  to: readonly E[],
  alpha: number,
  angles: readonly (keyof E)[] = [],
): E[] {
  if (alpha === 0 && from === to) return [...to];
  const before = new Map(from.map((e) => [e.id, e]));
  return to.map((e) => {
    const a = before.get(e.id);
    if (!a) return e;
    const out = { ...e, x: lerp(a.x, e.x, alpha), y: lerp(a.y, e.y, alpha) };
    for (const k of angles)
      (out as Record<keyof E, unknown>)[k] = lerpAngle(a[k] as number, e[k] as number, alpha);
    return out;
  });
}

export interface InterpolatedView {
  tick: number;
  /** The newer snapshot: everything that isn't interpolated (HUD, choices, team). */
  snapshot: Snapshot;
  players: NetPlayer[];
  enemies: NetEnemy[];
  projectiles: NetProjectile[];
}

export function interpolate(sample: BufferSample): InterpolatedView {
  const { from, to, alpha } = sample;
  return {
    tick: sample.tick,
    snapshot: to,
    players: interpolateList(from.players, to.players, alpha, ['aim', 'moveAngle']),
    enemies: interpolateList(from.enemies, to.enemies, alpha, ['face']),
    projectiles: interpolateList(from.projectiles, to.projectiles, alpha),
  };
}
