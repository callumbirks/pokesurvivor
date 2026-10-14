// The open map (original implementation, logic only): seeded value-noise terrain per tile, props
// placed by hashes, collision, liquids and breakable props. Everything here is a pure function of
// the seed and the set of broken props, so chunks are generated lazily into a cache that isn't part
// of the state. Rendering (tiles.js) is the client's job; it can call `terrainAt` / `chunkProps`.
//
// The rift arena is a walled circle carved into a far corner of the map (`world.arena`): terrain
// and props are a pure function of the seed, the arena and the broken props.
import { CHUNK, CHUNK_TILES as N, TILE } from './constants.js';
import { emit, type Ctx } from './ctx.js';
import { onSpecialBroken } from './interact.js';
import { clamp, dist2, hash2 } from './math.js';
import { dropPickup, dropXp } from './pickups.js';
import type { SimData } from './data.js';
import type { ArenaGeometry, WorldState } from './state.js';
import type { Arena } from '@pokesurvivor/data';

export const FLOOR = 0;
export const WALL = 1;
export const LIQUID = 2;
export type Terrain = typeof FLOOR | typeof WALL | typeof LIQUID;

export type PropType =
  'tree' | 'rock' | 'chest' | 'grass' | 'altar' | 'spring' | 'big-chest' | 'trap';
/** Interactables: altars, springs, locked chests and traps (see interact.ts). */
export const SPECIAL_PROPS: ReadonlySet<PropType> = new Set([
  'altar',
  'spring',
  'big-chest',
  'trap',
]);

export interface Prop {
  /** Tile key `"tx,ty"`: stable across chunk regeneration. */
  key: string;
  type: PropType;
  tx: number;
  ty: number;
  /** Variant (trap / altar kind). */
  kind: number;
  x: number;
  y: number;
  r: number;
  solid: boolean;
  flat: boolean;
  destructible: boolean;
  maxHp: number;
}

export interface Chunk {
  cx: number;
  cy: number;
  terr: Uint8Array;
  props: Prop[];
  /** Solid props by tile key. */
  propAt: Map<string, Prop>;
  /** The interactables among `props`. */
  specials: Prop[];
}

export interface ChunkCache {
  seed: number;
  chunks: Map<number, Chunk>;
}

const MAX_CHUNKS = 400;

export function createChunkCache(seed: number): ChunkCache {
  return { seed, chunks: new Map() };
}

/** The arena changed: chunks are regenerated (they're a pure function of the state). */
export function resetChunks(ctx: Ctx): void {
  ctx.chunks.chunks.clear();
}

// ---------------------------------------------------------------- noise

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s);
  const b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s);
  const d = hash2(xi + 1, yi + 1, s);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

const fbm = (x: number, y: number, s: number) =>
  vnoise(x, y, s) * 0.65 + vnoise(x * 2.13 + 17, y * 2.13 - 9, s + 1) * 0.35;

/** The look of a rift arena of `type` (normal if there's none for it). */
export function arenaTheme(d: SimData, type: string): Arena {
  const list = d.game.biomes.arenas;
  return list.find((a) => a.type === type) ?? (list[0] as Arena);
}

const arenaDist = (a: ArenaGeometry, tx: number, ty: number) => Math.hypot(tx - a.tx, ty - a.ty);
/** Walls and decor stop this far outside the arena's wall. */
const arenaOuter = (a: ArenaGeometry) => a.r + 7;

/** The arena's clear lane: where the team arrives (south) and the legendary waits (north). */
function arenaLane(a: ArenaGeometry, tx: number, ty: number): boolean {
  const lx = tx - a.tx;
  const ly = ty - a.ty;
  return (Math.abs(lx) <= 2 && ly >= -6 && ly <= 5) || Math.hypot(lx, ly) < 2.5;
}

/** Terrain of a tile, uncached. `arena`: the rift arena carved into the map, if any. */
export function terrainRaw(
  seed: number,
  tx: number,
  ty: number,
  arena: ArenaGeometry | null = null,
): Terrain {
  if (arena) {
    const ad = arenaDist(arena, tx, ty);
    if (ad < arenaOuter(arena)) {
      if (ad >= arena.r) return WALL;
      if (arenaLane(arena, tx, ty)) return FLOOR;
      // 2×2 pillars (cover) and pools, by the arena's type.
      const { pillars, pools } = arena;
      if (pillars && ad < arena.r - 2 && hash2(tx >> 1, ty >> 1, seed + 31 + arena.tx) < pillars)
        return WALL;
      if (pools && ad < arena.r - 1.5 && fbm(tx / 3.2, ty / 3.2, seed + 37 + arena.tx) < pools)
        return LIQUID;
      return FLOOR;
    }
  }
  const d = Math.hypot(tx, ty);
  if (d < 9) return FLOOR; // starting clearing
  const ramp = clamp((d - 9) / 8, 0, 1); // fades in
  if (fbm(tx / 13, ty / 13, seed + 101) < 0.04 + 0.23 * ramp) return LIQUID;
  if (fbm(tx / 8, ty / 8, seed + 202) > 1 - 0.27 * ramp) return WALL;
  return FLOOR;
}

// ---------------------------------------------------------------- chunks

const chunkKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
export const tileKey = (tx: number, ty: number): string => `${tx},${ty}`;

function makeProp(d: SimData, type: PropType, tx: number, ty: number, kind = 0): Prop {
  const def = d.prop(type);
  return {
    key: tileKey(tx, ty),
    type,
    tx,
    ty,
    kind,
    x: tx * TILE + TILE / 2,
    y: ty * TILE + TILE - 4,
    r: def.r,
    solid: def.solid,
    flat: def.flat,
    destructible: def.hp !== null,
    maxHp: def.hp ?? Infinity,
  };
}

function placeProps(d: SimData, w: WorldState, c: Chunk): void {
  const seed = w.seed;
  const arena = w.arena;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (c.terr[j * N + i] !== FLOOR) continue;
      const tx = c.cx * N + i;
      const ty = c.cy * N + j;
      if (Math.hypot(tx, ty) < 7) continue;
      if (w.broken[tileKey(tx, ty)]) continue;

      // Needs floor all around, so it doesn't stick to walls or water.
      let open = true;
      for (let b = -1; b <= 1 && open; b++) {
        for (let a = -1; a <= 1; a++) {
          if (terrainRaw(seed, tx + a, ty + b, arena) !== FLOOR) {
            open = false;
            break;
          }
        }
      }

      // In the arena: its type's decor (and nothing in the lane).
      if (arena && arenaDist(arena, tx, ty) < arenaOuter(arena) + 2) {
        const ad = arenaDist(arena, tx, ty);
        if (ad >= arena.r - 1.2 || arenaLane(arena, tx, ty)) continue;
        const pr = arenaTheme(d, arena.type).props;
        const tree = pr.tree ?? 0;
        const rock = pr.rock ?? 0;
        const hh = hash2(tx, ty, seed + 777);
        let at: PropType | null = null;
        if (open && hh < tree) at = 'tree';
        else if (open && hh < tree + rock) at = 'rock';
        else if (hh > 1 - (pr.grass ?? 0)) at = 'grass';
        if (at) {
          const p = makeProp(d, at, tx, ty);
          c.props.push(p);
          if (p.solid) c.propAt.set(p.key, p);
        }
        continue;
      }

      const h = hash2(tx, ty, seed + 404);
      const grove = fbm(tx / 10, ty / 10, seed + 505) > 0.6;
      let type: PropType | null = null;
      let kind = 0;
      // Interactables (rare), away from the starting clearing.
      const hs = hash2(tx, ty, seed + 909);
      if (open && Math.hypot(tx, ty) > 12 && hs < 0.0032) {
        type = hs < 0.0004 ? 'altar' : hs < 0.0008 ? 'spring' : hs < 0.0011 ? 'big-chest' : 'trap';
        kind = Math.floor(hash2(tx, ty, seed + 910) * (type === 'altar' ? 4 : 3));
      } else if (open && h < (grove ? 0.07 : 0.006)) type = 'tree';
      else if (open && h > 0.992) type = 'rock';
      else if (open && h > 0.985 && h <= 0.992 && hash2(tx, ty, seed + 606) < 0.07) type = 'chest';
      else if (fbm(tx / 5, ty / 5, seed + 707) > 0.66 && hash2(tx, ty, seed + 808) < 0.75)
        type = 'grass';
      if (!type) continue;

      const p = makeProp(d, type, tx, ty, kind);
      c.props.push(p);
      if (p.solid) c.propAt.set(p.key, p);
      if (SPECIAL_PROPS.has(type)) c.specials.push(p);
    }
  }
}

export function chunkAt(
  d: SimData,
  w: WorldState,
  cache: ChunkCache,
  cx: number,
  cy: number,
): Chunk {
  const k = chunkKey(cx, cy);
  let c = cache.chunks.get(k);
  if (c) return c;
  c = { cx, cy, terr: new Uint8Array(N * N), props: [], propAt: new Map(), specials: [] };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++)
      c.terr[j * N + i] = terrainRaw(w.seed, cx * N + i, cy * N + j, w.arena);
  }
  if (cache.chunks.size > MAX_CHUNKS) {
    const oldest = cache.chunks.keys().next().value;
    if (oldest !== undefined) cache.chunks.delete(oldest);
  }
  cache.chunks.set(k, c);
  placeProps(d, w, c);
  return c;
}

const tileOf = (v: number) => Math.floor(v / TILE);

export function terrainAt(ctx: Ctx, tx: number, ty: number): Terrain {
  const cx = Math.floor(tx / N);
  const cy = Math.floor(ty / N);
  const c = chunkAt(ctx.d, ctx.s.world, ctx.chunks, cx, cy);
  return c.terr[(ty - cy * N) * N + (tx - cx * N)] as Terrain;
}

export function propAtTile(ctx: Ctx, tx: number, ty: number): Prop | null {
  const c = chunkAt(ctx.d, ctx.s.world, ctx.chunks, Math.floor(tx / N), Math.floor(ty / N));
  return c.propAt.get(tileKey(tx, ty)) ?? null;
}

export const isWall = (ctx: Ctx, x: number, y: number): boolean =>
  terrainAt(ctx, tileOf(x), tileOf(y)) === WALL;
export const isLiquid = (ctx: Ctx, x: number, y: number): boolean =>
  terrainAt(ctx, tileOf(x), tileOf(y)) === LIQUID;

/** The liquid on the map now: the run biome's, or the arena's while the team is in it. */
export function liquidKind(ctx: Ctx): string {
  const a = ctx.s.world.arena;
  return a ? arenaTheme(ctx.d, a.type).liquid : ctx.d.biomeLiquid(ctx.s.world.biome);
}

/** Can a walker cross this tile? Walls, solid props and harmful liquids block (pathing). */
export function walkable(ctx: Ctx, tx: number, ty: number): boolean {
  const t = terrainAt(ctx, tx, ty);
  if (t === WALL) return false;
  if (t === LIQUID && ctx.d.liquidHurts(liquidKind(ctx))) return false;
  const p = propAtTile(ctx, tx, ty);
  return !(p && p.solid);
}

/** Is there room for something of radius r here? */
export function isFree(ctx: Ctx, x: number, y: number, r = 12, allowLiquid = false): boolean {
  const t0x = tileOf(x - r);
  const t1x = tileOf(x + r);
  const t0y = tileOf(y - r);
  const t1y = tileOf(y + r);
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      const t = terrainAt(ctx, tx, ty);
      if (t === WALL || (!allowLiquid && t === LIQUID)) return false;
      const p = propAtTile(ctx, tx, ty);
      if (p && dist2(x, y, p.x, p.y) < (r + p.r) ** 2) return false;
    }
  }
  return true;
}

export const propHp = (ctx: Ctx, p: Prop): number => ctx.s.world.propHp[p.key] ?? p.maxHp;

function chunksAround(ctx: Ctx, x: number, y: number, r: number, fn: (c: Chunk) => void) {
  const c0x = Math.floor((x - r) / CHUNK);
  const c1x = Math.floor((x + r) / CHUNK);
  const c0y = Math.floor((y - r) / CHUNK);
  const c1y = Math.floor((y + r) / CHUNK);
  for (let cy = c0y; cy <= c1y; cy++) {
    for (let cx = c0x; cx <= c1x; cx++) fn(chunkAt(ctx.d, ctx.s.world, ctx.chunks, cx, cy));
  }
}

/** Breakable props (tall grass included) touching a circle. */
export function propsInCircle(ctx: Ctx, x: number, y: number, r: number): Prop[] {
  const out: Prop[] = [];
  chunksAround(ctx, x, y, r, (c) => {
    for (const p of c.props) {
      if (!p.destructible || propHp(ctx, p) <= 0) continue;
      if (dist2(x, y, p.x, p.y) <= (r + p.r) ** 2) out.push(p);
    }
  });
  return out;
}

/** Every live prop in a rectangle (for renderers: terrain comes from `terrainRaw`). */
export function propsInRect(ctx: Ctx, x0: number, y0: number, x1: number, y1: number): Prop[] {
  const out: Prop[] = [];
  for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
    for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
      for (const p of chunkAt(ctx.d, ctx.s.world, ctx.chunks, cx, cy).props) {
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
      }
    }
  }
  return out;
}

/** Interactables near a point. */
export function specialsNear(ctx: Ctx, x: number, y: number, r: number): Prop[] {
  const out: Prop[] = [];
  chunksAround(ctx, x, y, r, (c) => {
    for (const p of c.specials) if (dist2(x, y, p.x, p.y) <= (r + p.r) ** 2) out.push(p);
  });
  return out;
}

/** Nearest rock or chest (players aim at them when there are no enemies). */
export function nearestBreakable(ctx: Ctx, x: number, y: number, r: number): Prop | null {
  let best: Prop | null = null;
  let bd = r * r;
  for (const p of propsInCircle(ctx, x, y, r)) {
    if (!p.solid) continue;
    const d = dist2(x, y, p.x, p.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** Finds a live prop by tile key (in generated chunks). */
export function propByKey(ctx: Ctx, key: string): Prop | null {
  const [tx = 0, ty = 0] = key.split(',').map(Number);
  const c = chunkAt(ctx.d, ctx.s.world, ctx.chunks, Math.floor(tx / N), Math.floor(ty / N));
  return c.props.find((p) => p.key === key) ?? null;
}

/**
 * Pushes a circle out of walls and solid props (sliding along them). Returns true if it hit
 * something.
 */
export function collide(ctx: Ctx, e: { x: number; y: number; r: number }): boolean {
  const r = e.r;
  let hit = false;
  for (let pass = 0; pass < 2; pass++) {
    const t0x = tileOf(e.x - r);
    const t1x = tileOf(e.x + r);
    const t0y = tileOf(e.y - r);
    const t1y = tileOf(e.y + r);
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        if (terrainAt(ctx, tx, ty) === WALL) {
          // Closest point of the tile's box to the circle's centre.
          const bx0 = tx * TILE;
          const by0 = ty * TILE;
          const bx1 = bx0 + TILE;
          const by1 = by0 + TILE;
          const qx = clamp(e.x, bx0, bx1);
          const qy = clamp(e.y, by0, by1);
          const dx = e.x - qx;
          const dy = e.y - qy;
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r) {
            hit = true;
            if (d2 > 1e-6) {
              const dd = Math.sqrt(d2);
              e.x += (dx / dd) * (r - dd);
              e.y += (dy / dd) * (r - dd);
            } else {
              // Centre inside the box: leave by the nearest side.
              const l = e.x - bx0;
              const rr = bx1 - e.x;
              const u = e.y - by0;
              const b = by1 - e.y;
              const m = Math.min(l, rr, u, b);
              if (m === l) e.x = bx0 - r;
              else if (m === rr) e.x = bx1 + r;
              else if (m === u) e.y = by0 - r;
              else e.y = by1 + r;
            }
          }
        }
        const p = propAtTile(ctx, tx, ty);
        if (p && p.solid) {
          const dx = e.x - p.x;
          const dy = e.y - p.y;
          const min = r + p.r;
          const d2 = dx * dx + dy * dy;
          if (d2 < min * min) {
            hit = true;
            const dd = Math.sqrt(d2) || 0.01;
            e.x = p.x + (dx / dd) * min;
            e.y = p.y + (dy / dd) * min;
          }
        }
      }
    }
  }
  return hit;
}

/** Does a projectile hit cover here? Returns 'wall', the solid prop, or null. */
export function projectileBlock(ctx: Ctx, x: number, y: number, r: number): 'wall' | Prop | null {
  const tx = tileOf(x);
  const ty = tileOf(y);
  if (terrainAt(ctx, tx, ty) === WALL) return 'wall';
  for (let b = -1; b <= 1; b++) {
    for (let a = -1; a <= 1; a++) {
      const p = propAtTile(ctx, tx + a, ty + b);
      if (p && p.solid && dist2(x, y, p.x, p.y) < (r + p.r) ** 2) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------- breaking props

/** Damages a breakable prop. Returns true if it broke. */
export function damageProp(ctx: Ctx, p: Prop, amount: number): boolean {
  const hp = propHp(ctx, p);
  if (!p.destructible || hp <= 0) return false;
  const left = hp - amount;
  if (p.type !== 'grass') emit(ctx, { type: 'prop-hit', key: p.key, x: p.x, y: p.y });
  if (left <= 0) {
    destroyProp(ctx, p);
    return true;
  }
  ctx.s.world.propHp[p.key] = left;
  return false;
}

export function destroyProp(ctx: Ctx, p: Prop): void {
  const w = ctx.s.world;
  if (w.broken[p.key]) return;
  w.broken[p.key] = 1;
  delete w.propHp[p.key];
  const c = chunkAt(ctx.d, w, ctx.chunks, Math.floor(p.tx / N), Math.floor(p.ty / N));
  const i = c.props.indexOf(p);
  if (i >= 0) c.props.splice(i, 1);
  const j = c.specials.indexOf(p);
  if (j >= 0) c.specials.splice(j, 1);
  c.propAt.delete(p.key);
  emit(ctx, { type: 'prop-broken', key: p.key, propType: p.type, x: p.x, y: p.y });

  const { rand } = ctx;
  if (p.type === 'grass') {
    const r = rand();
    if (r < 0.05) dropPickup(ctx, 'heal', p.x, p.y);
    else if (r < 0.11) dropPickup(ctx, 'coin', p.x, p.y, 1);
    return;
  }
  if (p.type === 'rock') {
    const r = rand();
    if (r < 0.4) dropXp(ctx, p.x, p.y, 6);
    if (r > 0.75) dropPickup(ctx, 'coin', p.x, p.y, 2);
    if (r > 0.94) dropPickup(ctx, 'heal', p.x + 8, p.y);
    return;
  }
  if (p.type === 'chest') {
    const n = rand.int(4, 7);
    for (let i = 0; i < n; i++) {
      dropPickup(ctx, 'coin', p.x + rand.range(-14, 14), p.y + rand.range(-10, 10), 3);
    }
    dropPickup(ctx, rand() < 0.5 ? 'heal' : 'magnet', p.x, p.y);
    dropXp(ctx, p.x, p.y, 20);
    if (rand() < 0.08) dropPickup(ctx, 'item', p.x, p.y - 12, 0, rollItem(ctx));
    return;
  }
  // Locked chests (opened by standing next to them) and traps (stepped on).
  onSpecialBroken(ctx, p);
}

/** A random held item, different from `except` (original `Items.roll`). */
export function rollItem(ctx: Ctx, except?: string): string {
  const pool = ctx.d.game.items.filter((i) => i.id !== except);
  return ctx.rand.pick(pool).id;
}
