// The map as drawn (port of the drawing half of legacy world/world.js): ground chunks baked at art
// resolution from the sim's terrain (`WorldView`), animated liquid glints, props sorted with the
// entities, the biome crossfade and the vignette.
import {
  CHUNK,
  CHUNK_TILES as N,
  FLOOR,
  LIQUID,
  TILE,
  WALL,
  WorldView,
  hash2,
} from '@pokesurvivor/sim';
import type { ArenaGeometry, Prop } from '@pokesurvivor/sim';
import { PX, whiteOf } from '../../sprites.js';
import type { Camera } from './camera.js';
import type { FX } from './fx.js';
import { allBiomes, biomeIndex, paintChunk, propSprite, type TerrainKind } from './tiles.js';

const KIND: TerrainKind[] = ['floor', 'wall', 'liquid'];
/** The biome crossfade (seconds). */
const FADE = 2.6;
const MAX_IMAGES = 48;
const CHEST_SECONDS = 3.5;

// Value noise for the dirt patches (legacy world.js; the sim's is internal).
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

export class WorldRenderer {
  readonly view: WorldView;
  private biome = -1;
  private images = new Map<string, HTMLCanvasElement>();
  private fade: { from: number; images: Map<string, HTMLCanvasElement>; t: number } | null = null;
  private liquids = new Map<string, number[]>();
  private flashes = new Map<string, number>();
  private arenaKey = '';

  constructor(readonly seed: number) {
    this.view = new WorldView(seed);
  }

  /** The palette in use: the run biome, or the arena's. */
  get paletteIndex(): number {
    return this.biome < 0 ? 0 : this.biome;
  }

  get biomeName(): string {
    return allBiomes()[this.paletteIndex]?.name ?? '';
  }

  /** Syncs the world from the snapshot. A biome change crossfades unless `instant`. */
  sync(
    runBiome: number,
    arena: ArenaGeometry | null,
    records: Readonly<Record<string, Readonly<Record<string, number>>>>,
    instant = false,
  ): void {
    const key = arena ? `${arena.tx},${arena.ty},${arena.r}` : '';
    if (key !== this.arenaKey) {
      // Terrain changed (an arena carved in or gone): rebake everything at once.
      this.arenaKey = key;
      this.view.setArena(arena);
      this.images.clear();
      this.liquids.clear();
      this.fade = null;
      instant = true;
    }
    this.view.setBiome(runBiome);
    this.view.setRecords(records);
    const b = biomeIndex(runBiome, arena?.type ?? null);
    if (b !== this.biome) {
      this.fade =
        instant || this.biome < 0 ? null : { from: this.biome, images: this.images, t: 0 };
      this.biome = b;
      this.images = new Map();
    }
  }

  /** A prop was hit: it flashes white. */
  flashProp(key: string): void {
    this.flashes.set(key, 0.12);
  }

  update(dt: number): void {
    if (this.fade && (this.fade.t += dt) >= FADE) this.fade = null;
    for (const [k, t] of this.flashes) {
      if (t - dt <= 0) this.flashes.delete(k);
      else this.flashes.set(k, t - dt);
    }
  }

  private chunkImage(cx: number, cy: number, bi: number, cache: Map<string, HTMLCanvasElement>) {
    const k = `${cx},${cy}`;
    let img = cache.get(k);
    if (img) return img;
    const at = (tx: number, ty: number) => KIND[this.view.terrain(tx, ty)] ?? 'floor';
    // A continuous "dirt" field; tiles.ts samples it on a grid and interpolates per pixel.
    const S = 6 * 16;
    const dirtField = (gx: number, gy: number) => fbm(gx / S, gy / S, this.seed + 303);
    img = paintChunk(cx, cy, N, at, dirtField, bi, this.seed);
    if (cache.size > MAX_IMAGES) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(k, img);
    return img;
  }

  private fadeK(): number | null {
    if (!this.fade) return null;
    const x = Math.min(1, this.fade.t / FADE);
    return x * x * (3 - 2 * x);
  }

  private visibleChunks(cam: Camera, pad = 0): [number, number][] {
    const out: [number, number][] = [];
    const x0 = Math.floor((cam.left() - pad) / CHUNK);
    const x1 = Math.floor((cam.left() + cam.w + pad) / CHUNK);
    const y0 = Math.floor((cam.top() - pad) / CHUNK);
    const y1 = Math.floor((cam.top() + cam.h + pad) / CHUNK);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) out.push([cx, cy]);
    return out;
  }

  drawGround(ctx: CanvasRenderingContext2D, cam: Camera): void {
    ctx.imageSmoothingEnabled = false;
    const k = this.fadeK();
    const bi = this.paletteIndex;
    for (const [cx, cy] of this.visibleChunks(cam)) {
      // +1 overlap: avoids seams between chunks at non-integer scales.
      const x = cx * CHUNK;
      const y = cy * CHUNK;
      if (k === null || !this.fade) {
        ctx.drawImage(this.chunkImage(cx, cy, bi, this.images), x, y, CHUNK + 1, CHUNK + 1);
        continue;
      }
      // Crossfade: the old biome below, the new one appearing on top.
      ctx.drawImage(
        this.chunkImage(cx, cy, this.fade.from, this.fade.images),
        x,
        y,
        CHUNK + 1,
        CHUNK + 1,
      );
      ctx.globalAlpha = k;
      ctx.drawImage(this.chunkImage(cx, cy, bi, this.images), x, y, CHUNK + 1, CHUNK + 1);
      ctx.globalAlpha = 1;
    }
  }

  private liquidTiles(cx: number, cy: number): number[] {
    const k = `${cx},${cy}`;
    let list = this.liquids.get(k);
    if (list) return list;
    list = [];
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++)
        if (this.view.terrain(cx * N + i, cy * N + j) === LIQUID) list.push(cx * N + i, cy * N + j);
    if (this.liquids.size > 200) this.liquids.clear();
    this.liquids.set(k, list);
    return list;
  }

  /** Glints on water, bubbles on lava (and poison and sparks). */
  drawLiquid(ctx: CanvasRenderingContext2D, cam: Camera, t: number): void {
    const B = allBiomes()[this.paletteIndex];
    if (!B) return;
    const lava = B.liquid === 'lava' || B.liquid === 'poison' || B.liquid === 'spark';
    ctx.fillStyle = B.foam;
    for (const [cx, cy] of this.visibleChunks(cam)) {
      const tiles = this.liquidTiles(cx, cy);
      for (let i = 0; i < tiles.length; i += 2) {
        const tx = tiles[i]!;
        const ty = tiles[i + 1]!;
        const x = tx * TILE;
        const y = ty * TILE;
        if (!cam.sees(x + TILE / 2, y + TILE / 2, TILE)) continue;
        const ph = hash2(tx, ty, 77) * 6.28;
        const k = (Math.sin(t * (lava ? 2.2 : 1.6) + ph) + 1) / 2;
        ctx.globalAlpha = lava ? 0.35 + k * 0.5 : k * 0.7;
        const sx = x + Math.floor(hash2(tx, ty, 78) * 12 + 2) * PX;
        const sy = y + Math.floor(hash2(tx, ty, 79) * 12 + 2) * PX;
        ctx.fillRect(sx + Math.round(k * 2) * PX, sy, PX * (lava ? 2 : 3), PX);
        if (lava && k > 0.8) ctx.fillRect(sx, sy - PX * 2, PX, PX);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Props in view, to sort by Y with the entities. */
  visibleProps(cam: Camera): Prop[] {
    const pad = 70;
    return this.view.propsInRect(
      cam.left() - pad,
      cam.top() - pad,
      cam.left() + cam.w + pad,
      cam.top() + cam.h + pad + 40,
    );
  }

  drawProp(ctx: CanvasRenderingContext2D, p: Prop, t: number, fx: FX): void {
    const w0 = this.view.world;
    const wiggle = hash2(p.tx, p.ty, 5) * 6.28;
    const used = !!w0.altarsUsed[p.key];
    const charge = w0.springs[p.key] ?? 1;
    const type = p.type;
    const variant =
      p.type === 'grass'
        ? Math.sin(t * 2.4 + wiggle) > 0.55
          ? 1
          : 0
        : p.type === 'rock'
          ? this.view.propHp(p) < p.maxHp * 0.5
            ? 1
            : 0
          : p.type === 'altar'
            ? p.kind * 2 + (used ? 1 : 0)
            : p.type === 'spring'
              ? charge < 0.15
                ? 1
                : 0
              : p.type === 'trap'
                ? p.kind
                : 0;
    const img = propSprite(this.paletteIndex, type, variant);
    const w = img.width * PX;
    const h = img.height * PX;
    if (p.flat) {
      // Flat ones (springs, traps): on the ground, centred on their tile.
      ctx.drawImage(img, Math.round(p.x - w / 2), Math.round(p.y - 8 - h / 2), w, h);
      if (p.type === 'spring' && charge >= 0.15 && Math.sin(t * 3 + wiggle) > 0.92)
        fx.twinkle(p.x + (Math.random() * 40 - 20), p.y - 8 + (Math.random() * 12 - 6));
      return;
    }
    if (p.type === 'altar' && !used) {
      // The orb's halo, pulsing.
      const col = ['#ff5f6d', '#5fd4ff', '#ff8ad8', '#ffd23f'][p.kind] ?? '#ffd23f';
      ctx.save();
      ctx.globalAlpha = 0.22 + Math.sin(t * 3 + wiggle) * 0.1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p.x, p.y - h + 11 * PX, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const open = w0.chests[p.key] ?? 0;
    if (p.type === 'big-chest' && open > 0) {
      ctx.save();
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(
        p.x,
        p.y - h / 2,
        26,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * Math.min(1, open / CHEST_SECONDS),
      );
      ctx.stroke();
      ctx.restore();
    }
    if (p.type !== 'grass') {
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r * 1.1, p.r * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    const lift = p.type === 'grass' ? 4 : 2;
    const x = Math.round(p.x - w / 2);
    const y = Math.round(p.y - h + lift);
    const k = this.fadeK();
    if (k !== null && this.fade) {
      // The old prop fades out while the new one appears.
      const old = propSprite(this.fade.from, type, variant);
      ctx.globalAlpha = 1 - k;
      ctx.drawImage(
        old,
        Math.round(p.x - (old.width * PX) / 2),
        Math.round(p.y - old.height * PX + lift),
        old.width * PX,
        old.height * PX,
      );
      ctx.globalAlpha = k;
    }
    ctx.drawImage(img, x, y, w, h);
    if (this.flashes.has(p.key)) {
      ctx.globalAlpha = 0.6;
      ctx.drawImage(whiteOf(img), x, y, w, h);
    }
    ctx.restore();
  }

  /** Wall or liquid at a world point (for effects). */
  terrainAt(x: number, y: number): 'floor' | 'wall' | 'liquid' {
    const t = this.view.terrain(Math.floor(x / TILE), Math.floor(y / TILE));
    return t === WALL ? 'wall' : t === LIQUID ? 'liquid' : t === FLOOR ? 'floor' : 'floor';
  }
}

/** The vignette, in screen coordinates. */
export function drawVignette(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.34,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.78,
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
