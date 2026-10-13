// Enemies walk around rocks and lakes (legacy systems/pathing.js). Every 0.35 s, a breadth-first
// search over the tiles around each player records how many steps each tile is from them; an
// enemy heads for the neighbouring tile with fewer steps.
//   - 8 neighbours, no corner cutting (no squeezing diagonally between two rocks).
//   - Blocked: walls, solid props, harmful liquids. Water can be crossed (it only slows).
//   - Hovering enemies don't need it: they fly straight.
// Cost: R = 28 tiles → 57 × 57 = 3,249 tiles per player every 0.35 s.
//
// The fields are a cache: the state keeps each field's origin tile, so they can be rebuilt after
// restoring a snapshot.
import { DT, TILE } from './constants.js';
import { activePlayers, type Ctx } from './ctx.js';
import { norm } from './math.js';
import { walkable } from './world.js';
import type { EnemyState, PlayerState } from './state.js';

const R = 28;
const N = R * 2 + 1;
const EVERY = 0.35;
const UNSEEN = 0x7fff;
const D8: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface PathField {
  ox: number;
  oy: number;
  dist: Int16Array;
  open: Uint8Array;
}

const queue = new Int32Array(N * N);

function build(ctx: Ctx, px: number, py: number): PathField {
  const ox = px - R;
  const oy = py - R;
  const dist = new Int16Array(N * N).fill(UNSEEN);
  const open = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) open[j * N + i] = walkable(ctx, ox + i, oy + j) ? 1 : 0;
  }
  const start = R * N + R;
  open[start] = 1; // where the player stands always counts
  dist[start] = 0;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  while (head < tail) {
    const c = queue[head++] ?? 0;
    const cx = c % N;
    const cy = (c / N) | 0;
    const d = (dist[c] ?? 0) + 1;
    for (let k = 0; k < 8; k++) {
      const [dx, dy] = D8[k] ?? [0, 0];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const n = ny * N + nx;
      if (!open[n] || dist[n] !== UNSEEN) continue;
      // Diagonal: both side tiles must be free.
      if (k >= 4 && (!open[cy * N + nx] || !open[ny * N + cx])) continue;
      dist[n] = d;
      queue[tail++] = n;
    }
  }
  return { ox, oy, dist, open };
}

/** The map changed under everyone (the arena): forget the fields, rebuild them next tick. */
export function resetPaths(ctx: Ctx): void {
  ctx.paths.clear();
  ctx.s.pathOrigins = {};
  ctx.s.pathTimer = 0;
}

/** Rebuilds the living players' fields every 0.35 s. */
export function updatePaths(ctx: Ctx): void {
  const { s } = ctx;
  s.pathTimer -= DT;
  if (s.pathTimer > 0) {
    // After a snapshot restore the cache is empty: rebuild from the recorded origins.
    for (const [id, o] of Object.entries(s.pathOrigins)) {
      if (!ctx.paths.has(id)) ctx.paths.set(id, build(ctx, o.tx, o.ty));
    }
    return;
  }
  s.pathTimer = EVERY;
  const players = activePlayers(s);
  for (const id of Object.keys(s.pathOrigins)) {
    if (!players.some((p) => p.id === id)) {
      delete s.pathOrigins[id];
      ctx.paths.delete(id);
    }
  }
  for (const p of players) {
    if (p.dead) continue;
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    s.pathOrigins[p.id] = { tx, ty };
    ctx.paths.set(p.id, build(ctx, tx, ty));
  }
}

/** Can a body of radius r go straight from (ax, ay) to (bx, by)? */
function clearLine(f: PathField, ax: number, ay: number, bx: number, by: number, r: number) {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1) return true;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const w = Math.min(r * 0.9, TILE * 0.45);
  for (let d = 0; d <= len; d += TILE * 0.4) {
    const cx = ax + ux * d;
    const cy = ay + uy * d;
    for (const s of [-w, 0, w]) {
      const x = Math.floor((cx - uy * s) / TILE) - f.ox;
      const y = Math.floor((cy + ux * s) / TILE) - f.oy;
      if (x < 0 || y < 0 || x >= N || y >= N) return false;
      if (!f.open[y * N + x]) return false;
    }
  }
  return true;
}

/**
 * Direction for `e` to reach `pl` around obstacles, or null when not needed (close, outside the
 * field, no path, or a clear line of sight).
 */
export function pathDir(ctx: Ctx, e: EnemyState, pl: PlayerState): [number, number] | null {
  const f = ctx.paths.get(pl.id);
  if (!f) return null;
  const tx = Math.floor(e.x / TILE) - f.ox;
  const ty = Math.floor(e.y / TILE) - f.oy;
  if (tx < 0 || ty < 0 || tx >= N || ty >= N) return null;
  const here = f.dist[ty * N + tx] ?? UNSEEN;
  if (here <= 1 || here === UNSEEN) return null; // next to you, or no path: straight
  // With a clear view of the player, straight at them (looks more natural). Checked every 0.2 s
  // per enemy (the expensive part).
  if (e.losT <= 0) {
    e.losT = 0.2;
    e.los = clearLine(f, e.x, e.y, pl.x, pl.y, e.r);
  }
  if (e.los) return null;
  // Next tile on the path (the neighbour with fewer steps, no corner cutting).
  let bx = tx;
  let by = ty;
  let best = here;
  for (let k = 0; k < 8; k++) {
    const [dx, dy] = D8[k] ?? [0, 0];
    const x = tx + dx;
    const y = ty + dy;
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const v = f.dist[y * N + x] ?? UNSEEN;
    if (v >= best) continue;
    if (k >= 4 && (!f.open[ty * N + x] || !f.open[y * N + tx])) continue;
    best = v;
    bx = x;
    by = y;
  }
  if (bx === tx && by === ty) return null;
  let gx = (f.ox + bx + 0.5) * TILE;
  let gy = (f.oy + by + 0.5) * TILE;
  // Off-centre with an obstacle in the way of the shortcut: first to the centre of its own tile
  // (so it doesn't snag on corners).
  if (!clearLine(f, e.x, e.y, gx, gy, e.r)) {
    gx = (f.ox + tx + 0.5) * TILE;
    gy = (f.oy + ty + 0.5) * TILE;
  }
  return norm(gx - e.x, gy - e.y);
}
