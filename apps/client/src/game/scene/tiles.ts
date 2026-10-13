// Pixel art of the world, painted in code (port of legacy world/tiles.js). Everything is painted at
// ART resolution (16 px per tile) into an ImageData and drawn scaled ×PX without smoothing, so the
// tiles share their pixel size with the Mystery Dungeon sprites.
//
// Autotiling: each tile looks at its 8 neighbours (wall edges, front faces, rounded corners, shore
// foam…). Palettes come from biomes.json: the run biomes, then one per rift arena type.
import { loadGameData } from '@pokesurvivor/data';
import { hash2 } from '@pokesurvivor/sim';

/** Art pixels per tile. */
export const T = 16;

export type TerrainKind = 'floor' | 'wall' | 'liquid';

export interface BiomePalette {
  name: string;
  liquid: string;
  prop: 'tree' | 'crystal' | 'dead';
  floor: string[];
  dirt: string[];
  speck: string;
  light: string;
  flowers: string[];
  wallTop: string[];
  wallLight: string;
  wallEdge: string;
  wallFace: string[];
  wallFaceDark: string;
  liq: string;
  liqDeep: string;
  foam: string;
  shore: string;
  leaf: string[];
  trunk: string[];
  rock: string[];
  grass: string[];
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Lightens (k > 0) or darkens (k < 0) a colour. */
export function shade(hex: string, k: number): string {
  const c = rgb(hex).map((v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

let biomes: BiomePalette[] | null = null;
let runCount = 3;
let arenaTypes: string[] = [];

/** Every palette: the run biomes first, then the arenas (see `arenaBiome`). */
export function allBiomes(): BiomePalette[] {
  if (biomes) return biomes;
  const data = loadGameData().biomes;
  runCount = data.runBiomes.length;
  arenaTypes = data.arenas.map((a) => a.type);
  biomes = [
    ...data.runBiomes.map((b): BiomePalette => ({
      name: b.name,
      liquid: b.liquid,
      prop: b.prop,
      floor: b.palette.floor,
      dirt: b.palette.dirt,
      speck: b.palette.speck,
      light: b.palette.light,
      flowers: b.palette.flowers,
      wallTop: b.palette.wallTop,
      wallLight: b.palette.wallLight,
      wallEdge: b.palette.wallEdge,
      wallFace: b.palette.wallFace,
      wallFaceDark: b.palette.wallFaceDark,
      liq: b.palette.liquid,
      liqDeep: b.palette.liquidDeep,
      foam: b.palette.foam,
      shore: b.palette.shore,
      leaf: b.palette.leaf,
      trunk: b.palette.trunk,
      rock: b.palette.rock,
      grass: b.palette.grass,
    })),
    ...data.arenas.map((a): BiomePalette => {
      // A full biome palette from the arena's few colours (legacy arenaBiome).
      const p = a.palette;
      const f = p.floor;
      const w = p.wall;
      const L = p.liquid;
      return {
        name: a.name,
        liquid: a.liquid,
        prop: a.prop,
        floor: [f, shade(f, 0.05), shade(f, -0.06)],
        dirt: [shade(f, -0.16), shade(f, -0.12), shade(f, -0.2)],
        speck: shade(f, -0.25),
        light: shade(f, 0.22),
        flowers: p.flowers,
        wallTop: [w, shade(w, 0.07), shade(w, -0.07)],
        wallLight: shade(w, 0.32),
        wallEdge: shade(w, -0.7),
        wallFace: [shade(w, -0.3), shade(w, -0.38)],
        wallFaceDark: shade(w, -0.55),
        liq: L,
        liqDeep: shade(L, -0.22),
        foam: p.foam ?? shade(L, 0.55),
        shore: shade(f, -0.32),
        leaf: [shade(p.leaf, -0.35), shade(p.leaf, -0.15), p.leaf, shade(p.leaf, 0.3)],
        trunk: [shade(p.trunk, -0.2), p.trunk],
        rock: [shade(p.rock, -0.2), p.rock, shade(p.rock, 0.22)],
        grass: [shade(p.grass, -0.28), p.grass, shade(p.grass, 0.28)],
      };
    }),
  ];
  return biomes;
}

/** Palette index of a run biome (cycling) or of the arena of a type. */
export function biomeIndex(runBiome: number, arenaType: string | null): number {
  allBiomes();
  if (arenaType !== null) return runCount + Math.max(0, arenaTypes.indexOf(arenaType));
  return ((runBiome % runCount) + runCount) % runCount;
}

// ---------------------------------------------------------------- pixel canvas

// Packed ABGR (little-endian) to write a whole pixel into a Uint32Array.
function pack(hex: string, a = 255): number {
  const [r, g, b] = rgb(hex);
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
function mixPack(h1: string, h2: string, t: number): number {
  const a = rgb(h1);
  const b = rgb(h2);
  const c = a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t));
  return ((255 << 24) | ((c[2] ?? 0) << 16) | ((c[1] ?? 0) << 8) | (c[0] ?? 0)) >>> 0;
}

interface Pix {
  w: number;
  h: number;
  set(x: number, y: number, col: number): void;
  get(x: number, y: number): number;
  canvas(): HTMLCanvasElement;
}

function makePix(w: number, h: number): Pix {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  if (!c) throw new Error('Canvas 2D is not available');
  const img = c.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  return {
    w,
    h,
    set(x, y, col) {
      if (x >= 0 && y >= 0 && x < w && y < h) buf[y * w + x] = col;
    },
    get(x, y) {
      return buf[y * w + x] ?? 0;
    },
    canvas() {
      c.putImageData(img, 0, 0);
      return cv;
    },
  };
}

const H = hash2;

// ---------------------------------------------------------------- ground chunks

/**
 * The chunk's dirt mask at pixel resolution (plus a row above, for edges). The noise is evaluated
 * every 4 px and interpolated: ~30 times fewer calls than per pixel.
 */
function dirtMask(
  gx0: number,
  gy0: number,
  W: number,
  field: (gx: number, gy: number) => number,
  seed: number,
) {
  const S = 4;
  const gw = W / S + 3;
  const grid = new Float32Array(gw * gw);
  for (let j = 0; j < gw; j++)
    for (let i = 0; i < gw; i++) grid[j * gw + i] = field(gx0 + (i - 1) * S, gy0 + (j - 1) * S);
  const mask = new Uint8Array(W * (W + 1));
  for (let y = -1; y < W; y++) {
    const fy = (y + S) / S;
    const j = Math.floor(fy);
    const v = fy - j;
    for (let x = 0; x < W; x++) {
      const fx = (x + S) / S;
      const i = Math.floor(fx);
      const u = fx - i;
      const a = grid[j * gw + i] ?? 0;
      const b = grid[j * gw + i + 1] ?? 0;
      const c = grid[(j + 1) * gw + i] ?? 0;
      const d = grid[(j + 1) * gw + i + 1] ?? 0;
      let val = (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
      val += (H((gx0 + x) >> 1, (gy0 + y) >> 1, seed + 9) - 0.5) * 0.05;
      mask[(y + 1) * W + x] = val > 0.64 ? 1 : 0;
    }
  }
  return (x: number, y: number) => mask[(y + 1) * W + x] === 1;
}

interface Colors {
  floor: number[];
  dirt: number[];
  wallTop: number[];
  wallFace: number[];
  flowers: number[];
  speck: number;
  light: number;
  wallLight: number;
  wallEdge: number;
  wallFaceDark: number;
  liq: number;
  liqDeep: number;
  liqLight: number;
  foam: number;
  shore: number;
}

/**
 * Paints a chunk of n×n tiles. `at(tx, ty)` is the global terrain kind, so autotiling sees past the
 * chunk's edge.
 */
export function paintChunk(
  cx: number,
  cy: number,
  n: number,
  at: (tx: number, ty: number) => TerrainKind,
  dirtField: (gx: number, gy: number) => number,
  bi: number,
  seed: number,
): HTMLCanvasElement {
  const B = allBiomes()[bi] ?? allBiomes()[0]!;
  const P = makePix(n * T, n * T);
  const C: Colors = {
    floor: B.floor.map((h) => pack(h)),
    dirt: B.dirt.map((h) => pack(h)),
    wallTop: B.wallTop.map((h) => pack(h)),
    wallFace: B.wallFace.map((h) => pack(h)),
    flowers: B.flowers.map((h) => pack(h)),
    speck: pack(B.speck),
    light: pack(B.light),
    wallLight: pack(B.wallLight),
    wallEdge: pack(B.wallEdge),
    wallFaceDark: pack(B.wallFaceDark),
    liq: pack(B.liq),
    liqDeep: pack(B.liqDeep),
    liqLight: mixPack(B.liq, B.foam, 0.28),
    foam: pack(B.foam),
    shore: pack(B.shore),
  };
  const tx0 = cx * n;
  const ty0 = cy * n;
  const dirtAt = dirtMask(tx0 * T, ty0 * T, n * T, dirtField, seed);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const tx = tx0 + i;
      const ty = ty0 + j;
      const ox = i * T;
      const oy = j * T;
      const kind = at(tx, ty);
      // Floor under everything (the walls' rounded corners show it).
      paintFloor(P, C, ox, oy, tx, ty, dirtAt, at);
      if (kind === 'wall') paintWall(P, C, ox, oy, tx, ty, at);
      else if (kind === 'liquid') paintLiquid(P, C, ox, oy, tx, ty, at);
    }
  }
  return P.canvas();
}

function paintFloor(
  P: Pix,
  C: Colors,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  dirtAt: (x: number, y: number) => boolean,
  at: (tx: number, ty: number) => TerrainKind,
) {
  let dirtCount = 0;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const gx = tx * T + x;
      const gy = ty * T + y;
      const lx = ox + x;
      const ly = oy + y;
      const dirt = dirtAt(lx, ly);
      if (dirt) dirtCount++;
      const pal = dirt ? C.dirt : C.floor;
      // Tone from smooth noise plus per-pixel dither.
      const band = H(gx >> 3, gy >> 3, 11) * 0.7 + H(gx, gy, 12) * 0.5;
      let col = pal[Math.min(pal.length - 1, Math.floor((band * pal.length) / 1.2))] ?? 0;
      const r = H(gx, gy, 13);
      if (r < 0.035) col = C.speck;
      else if (r > 0.985) col = C.light;
      // Dirt edge: a dark lip on top, grass creeping in below.
      if (dirt && !dirtAt(lx, ly - 1)) col = C.speck;
      else if (!dirt && dirtAt(lx, ly - 1) && r < 0.5) col = C.light;
      P.set(ox + x, oy + y, col);
    }
  }
  const dirt = dirtCount > (T * T) / 2;
  // Contact shadow under walls just north.
  if (at(tx, ty - 1) === 'wall') {
    for (let x = 0; x < T; x++) {
      P.set(ox + x, oy, C.wallFaceDark);
      if ((x + ty) % 2) P.set(ox + x, oy + 1, C.speck);
    }
  }
  // Details: a tuft, a pebble or a flower.
  const d = H(tx, ty, 14);
  const dx = ox + 3 + Math.floor(H(tx, ty, 15) * 10);
  const dy = oy + 4 + Math.floor(H(tx, ty, 16) * 9);
  if (dirt) {
    if (d < 0.22) {
      P.set(dx, dy, C.light);
      P.set(dx + 1, dy, C.light);
      P.set(dx, dy + 1, C.speck);
      P.set(dx + 1, dy + 1, C.speck);
    }
    return;
  }
  if (d < 0.18) {
    P.set(dx, dy, C.light);
    P.set(dx - 1, dy - 1, C.light);
    P.set(dx + 1, dy - 1, C.light);
    P.set(dx, dy - 2, C.light);
    P.set(dx, dy + 1, C.speck);
  } else if (d < 0.26) {
    const fc = C.flowers[Math.floor(H(tx, ty, 17) * C.flowers.length)] ?? C.light;
    P.set(dx, dy - 1, fc);
    P.set(dx - 1, dy, fc);
    P.set(dx + 1, dy, fc);
    P.set(dx, dy + 1, fc);
    P.set(dx, dy, C.light);
  } else if (d < 0.32) {
    P.set(dx, dy, C.light);
    P.set(dx + 1, dy, C.light);
    P.set(dx, dy + 1, C.speck);
    P.set(dx + 1, dy + 1, C.speck);
  }
}

function paintWall(
  P: Pix,
  C: Colors,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  at: (tx: number, ty: number) => TerrainKind,
) {
  const W = (x: number, y: number) => at(x, y) === 'wall';
  const n = W(tx, ty - 1);
  const s = W(tx, ty + 1);
  const w = W(tx - 1, ty);
  const e = W(tx + 1, ty);
  const FACE = s ? 0 : 6; // rows of visible front face
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      // Rounded outer corners show the floor.
      if (!n && !w && x + y < 3) continue;
      if (!n && !e && T - 1 - x + y < 3) continue;
      if (!s && !w && x + (T - 1 - y) < 2) continue;
      if (!s && !e && T - 1 - x + (T - 1 - y) < 2) continue;
      const gx = tx * T + x;
      const gy = ty * T + y;
      let col: number;
      if (y >= T - FACE) {
        // Front face: vertical streaks and a dark base.
        const fy = y - (T - FACE);
        col = C.wallFace[(x + (H(gx, 0, 21) < 0.5 ? 0 : 1)) % 3 === 0 ? 1 : 0] ?? 0;
        if (fy === 0) col = C.wallEdge;
        else if (y === T - 1) col = C.wallFaceDark;
        else if (H(gx, gy, 22) < 0.08) col = C.wallFaceDark;
      } else {
        // Top face with dither.
        col =
          C.wallTop[
            Math.floor(H(gx >> 1, gy >> 1, 23) * 2.2 + H(gx, gy, 24) * 0.8) % C.wallTop.length
          ] ?? 0;
        if (H(gx, gy, 25) < 0.05) col = C.wallLight;
        // Edges: light on the north, a dark outline on the sides.
        if (!n && y === 0) col = C.wallEdge;
        else if (!n && y === 1) col = C.wallLight;
        if (!w && x === 0) col = C.wallEdge;
        if (!e && x === T - 1) col = C.wallEdge;
      }
      P.set(ox + x, oy + y, col);
    }
  }
}

function paintLiquid(
  P: Pix,
  C: Colors,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  at: (tx: number, ty: number) => TerrainKind,
) {
  const L = (x: number, y: number) => at(x, y) === 'liquid';
  const n = L(tx, ty - 1);
  const s = L(tx, ty + 1);
  const w = L(tx - 1, ty);
  const e = L(tx + 1, ty);
  const nw = L(tx - 1, ty - 1);
  const ne = L(tx + 1, ty - 1);
  const sw = L(tx - 1, ty + 1);
  const se = L(tx + 1, ty + 1);
  const BIG = 99;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      // Rounded outer corners show the floor below.
      if (!n && !w && x + y < 3) continue;
      if (!n && !e && T - 1 - x + y < 3) continue;
      if (!s && !w && x + (T - 1 - y) < 3) continue;
      if (!s && !e && T - 1 - x + (T - 1 - y) < 3) continue;
      // Distance to the shore within the tile (inner corners included).
      let d = Math.min(n ? BIG : y, s ? BIG : T - 1 - y, w ? BIG : x, e ? BIG : T - 1 - x);
      if (n && w && !nw) d = Math.min(d, Math.hypot(x, y) - 0.5);
      if (n && e && !ne) d = Math.min(d, Math.hypot(T - 1 - x, y) - 0.5);
      if (s && w && !sw) d = Math.min(d, Math.hypot(x, T - 1 - y) - 0.5);
      if (s && e && !se) d = Math.min(d, Math.hypot(T - 1 - x, T - 1 - y) - 0.5);
      const gx = tx * T + x;
      const gy = ty * T + y;
      const r = H(gx, gy, 31);
      let col: number;
      if (d < 1) col = C.shore;
      else if (d < 2) col = C.foam;
      else if (d < 4) col = C.liqLight;
      else if (d < 6) col = r < 0.5 ? C.liq : C.liqLight;
      else col = d < 8 && r < 0.5 ? C.liq : C.liqDeep;
      if (d >= 6 && d < BIG && r < 0.08) col = C.liq;
      // Loose waves: a few 3 px horizontal dashes.
      if (d >= 3 && H(gx >> 2, gy, 33) < 0.045 && (gx & 3) !== 3) col = C.liqLight;
      if (d >= 3 && H(gx, gy, 34) < 0.004) col = C.foam;
      P.set(ox + x, oy + y, col);
    }
  }
}

// ---------------------------------------------------------------- prop sprites

const propCache = new Map<string, HTMLCanvasElement>();

export type PropSprite =
  'tree' | 'rock' | 'grass' | 'altar' | 'spring' | 'big-chest' | 'trap' | 'rift' | 'chest';

export function propSprite(bi: number, type: PropSprite, variant = 0): HTMLCanvasElement {
  const k = `${bi}/${type}/${variant}`;
  let cv = propCache.get(k);
  if (!cv) {
    const B = allBiomes()[bi] ?? allBiomes()[0]!;
    cv = PAINT[type](B, variant);
    propCache.set(k, cv);
  }
  return cv;
}

function disc(
  P: Pix,
  cx: number,
  cy: number,
  r: number,
  colFn: (x: number, y: number, d: number) => number | null,
) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        const c = colFn(x, y, d / r);
        if (c != null) P.set(x, y, c);
      }
    }
}

/** A 1 px outline around everything opaque. */
function outline(P: Pix, col: number) {
  const marks: [number, number][] = [];
  for (let y = 0; y < P.h; y++)
    for (let x = 0; x < P.w; x++) {
      if (P.get(x, y) >>> 24) continue;
      const near = (
        [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const
      ).some(([a, b]) => {
        const xx = x + a;
        const yy = y + b;
        return xx >= 0 && yy >= 0 && xx < P.w && yy < P.h && P.get(xx, yy) >>> 24;
      });
      if (near) marks.push([x, y]);
    }
  for (const [x, y] of marks) P.set(x, y, col);
}

const at = <T>(a: readonly T[], i: number): T => a[Math.max(0, Math.min(a.length - 1, i))]!;

const PAINT: Record<PropSprite, (B: BiomePalette, variant: number) => HTMLCanvasElement> = {
  tree(B) {
    if (B.prop === 'crystal') return paintCrystal(B);
    if (B.prop === 'dead') return paintDeadTree(B);
    const P = makePix(30, 40);
    const L = B.leaf.map((h) => pack(h));
    const Tr = B.trunk.map((h) => pack(h));
    const edge = pack('#14200f');
    for (let y = 26; y < 38; y++)
      for (let x = 13; x < 18; x++) P.set(x, y, at(Tr, x === 13 || x === 17 ? 0 : 1));
    P.set(12, 37, at(Tr, 0));
    P.set(18, 37, at(Tr, 0));
    P.set(11, 38, at(Tr, 0));
    P.set(19, 38, at(Tr, 0));
    const blobs = [
      [15, 20, 10],
      [9, 16, 7],
      [21, 16, 7],
      [15, 10, 8],
      [10, 23, 6],
      [20, 23, 6],
    ] as const;
    for (const [bx, by, br] of blobs) {
      disc(P, bx, by, br, (x, y) => {
        // Light from the top left.
        const lit = ((x - bx) * -0.6 + (y - by) * -0.8) / br;
        const idx = lit > 0.45 ? 3 : lit > 0.05 ? 2 : lit > -0.45 ? 1 : 0;
        return H(x, y, 41) < 0.12 && idx > 0 ? at(L, idx - 1) : at(L, idx);
      });
    }
    outline(P, edge);
    return P.canvas();
  },

  rock(B, variant) {
    const P = makePix(22, 17);
    const R = B.rock.map((h) => pack(h));
    const shine = pack('#ffffff');
    // A flattened boulder: an ellipse wider than tall, flat base.
    for (let y = 2; y <= 15; y++)
      for (let x = 1; x <= 20; x++) {
        const nx = (x - 10.5) / 9.5;
        const ny = (y - 9.5) / 7;
        const d = nx * nx + ny * ny + (H(x, y, 61) - 0.5) * 0.08;
        if (d > 1) continue;
        const lit = -nx * 0.55 - ny * 0.85 + (H(x, y, 62) - 0.5) * 0.25;
        let c = at(R, lit > 0.4 ? 2 : lit > -0.15 ? 1 : 0);
        if (y >= 14) c = at(R, 0);
        P.set(x, y, c);
      }
    for (const [x, y] of [
      [6, 5],
      [7, 5],
      [6, 6],
      [8, 4],
    ] as const)
      P.set(x, y, shine);
    for (const [x, y] of [
      [13, 8],
      [14, 9],
      [9, 11],
      [16, 11],
      [11, 7],
    ] as const)
      P.set(x, y, at(R, 0));
    // Cracks on the damaged variant.
    if (variant === 1) {
      const dark = pack('#1b1d22');
      for (const [x, y] of [
        [9, 4],
        [10, 5],
        [10, 6],
        [11, 7],
        [10, 8],
        [12, 8],
        [13, 9],
        [8, 9],
        [7, 10],
      ] as const)
        P.set(x, y, dark);
    }
    outline(P, pack('#17191d'));
    return P.canvas();
  },

  grass(B, variant) {
    // A fan of blades: each a curve leaning outwards, dark base and light tip. Variant 1 is the
    // "swaying in the wind" frame.
    const P = makePix(20, 17);
    const Gc = B.grass.map((h) => pack(h));
    const dark = pack(B.speck);
    const sway = variant === 1 ? 1.2 : 0;
    const blades = 11;
    // The back ones first (darker), then the front ones.
    for (let pass = 0; pass < 2; pass++) {
      for (let b = pass; b < blades; b += 2) {
        const t = b / (blades - 1);
        const x0 = 3 + t * 13 + (H(b, 7, 52) - 0.5) * 2;
        const hgt = 8 + Math.floor(H(b, 3, 51) * 6) + (Math.abs(t - 0.5) < 0.25 ? 3 : 0);
        const lean = (t - 0.5) * 7 + sway * (0.6 + H(b, 1, 53));
        for (let i = 0; i <= hgt; i++) {
          const k = i / hgt;
          const x = Math.round(x0 + lean * k * k);
          const y = 16 - i;
          let c = k > 0.78 ? at(Gc, 2) : k > 0.25 ? at(Gc, 1) : at(Gc, 0);
          if (pass === 0 && k <= 0.78) c = at(Gc, 0);
          P.set(x, y, c);
          if (i < hgt * 0.45) P.set(x + 1, y, k < 0.15 ? dark : at(Gc, 0));
        }
      }
    }
    outline(P, pack('#0e1d0c'));
    return P.canvas();
  },

  /** Power altar: variant = kind × 2 + (used ? 1 : 0). */
  altar(B, variant) {
    const P = makePix(18, 27);
    const R = B.rock.map((h) => pack(h));
    const eff = variant >> 1;
    const used = variant & 1;
    const ORB = [
      ['#ff5f6d', '#c23a4b', '#ffd3d8'],
      ['#5fd4ff', '#2a8fd0', '#d8f6ff'],
      ['#ff8ad8', '#b03d84', '#ffe0f4'],
      ['#ffd23f', '#c08a10', '#fff3b0'],
    ];
    const O = (used ? ['#6b7380', '#4a505c', '#9aa2ae'] : at(ORB, eff)).map((h) => pack(h));
    for (let y = 21; y <= 25; y++)
      for (let x = 1; x <= 16; x++) P.set(x, y, at(R, y === 21 ? 2 : y >= 24 ? 0 : 1));
    for (let y = 12; y <= 20; y++)
      for (let x = 5; x <= 12; x++) P.set(x, y, at(R, x === 5 ? 2 : x >= 11 ? 0 : 1));
    for (let y = 10; y <= 11; y++)
      for (let x = 3; x <= 14; x++) P.set(x, y, at(R, y === 10 ? 2 : 1));
    // Runes of its colour on the column.
    for (const [x, y] of [
      [7, 14],
      [8, 15],
      [10, 14],
      [9, 17],
      [7, 18],
      [10, 18],
    ] as const)
      P.set(x, y, at(O, 1));
    // The orb.
    disc(P, 8.5, 5.5, 4.2, (x, y, d) => {
      const lit = (8.5 - x) * 0.5 + (5.5 - y) * 0.7;
      return lit > 1.6 ? at(O, 2) : d > 0.75 ? at(O, 1) : at(O, 0);
    });
    outline(P, pack('#120e1a'));
    return P.canvas();
  },

  /** Healing spring: variant 1 = drained. */
  spring(B, variant) {
    const P = makePix(34, 16);
    const R = B.rock.map((h) => pack(h));
    const W = (variant ? ['#2f5f68', '#3a6f7a', '#4f8a92'] : ['#2ba8b8', '#5fe8d8', '#b8fff4']).map(
      (h) => pack(h),
    );
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 34; x++) {
        const nx = (x - 16.5) / 16.5;
        const ny = (y - 8) / 7.5;
        const d = nx * nx + ny * ny;
        if (d > 1) continue;
        if (d > 0.62) {
          P.set(x, y, at(R, (H(x, y, 71) < 0.5 ? 1 : 0) + (ny < -0.2 ? 1 : 0)));
          continue;
        }
        const wave = Math.sin(x * 0.7 + y * 1.3) > 0.6;
        P.set(x, y, d < 0.18 ? at(W, 2) : wave ? at(W, 2) : d < 0.4 ? at(W, 1) : at(W, 0));
      }
    if (!variant)
      for (const [x, y] of [
        [10, 6],
        [11, 5],
        [22, 9],
        [23, 8],
        [16, 11],
      ] as const)
        P.set(x, y, pack('#ffffff'));
    outline(P, pack('#14161c'));
    return P.canvas();
  },

  /** A big chest with a padlock. */
  'big-chest'() {
    const P = makePix(24, 20);
    const wood = pack('#6b3a1e');
    const woodL = pack('#8e5329');
    const woodD = pack('#432210');
    const iron = pack('#9aa6b5');
    const ironD = pack('#5d6773');
    const gold = pack('#f2c443');
    const goldD = pack('#b5832a');
    for (let y = 2; y < 19; y++)
      for (let x = 1; x < 23; x++) {
        let c = y < 8 ? woodL : wood;
        if (y === 8 || y === 9) c = ironD;
        if (x === 1 || x === 22 || y === 18) c = woodD;
        if (x === 5 || x === 6 || x === 17 || x === 18) c = x === 5 || x === 17 ? iron : ironD;
        if (y === 2 && x > 1 && x < 22) c = iron;
        P.set(x, y, c);
      }
    for (let x = 10; x <= 13; x++) P.set(x, 5, iron);
    P.set(9, 6, iron);
    P.set(14, 6, iron);
    P.set(9, 7, iron);
    P.set(14, 7, iron);
    for (let y = 8; y <= 13; y++)
      for (let x = 8; x <= 15; x++) P.set(x, y, (x + y) % 4 ? gold : goldD);
    P.set(11, 10, woodD);
    P.set(12, 10, woodD);
    P.set(11, 11, woodD);
    P.set(11, 12, woodD);
    outline(P, pack('#1e0f06'));
    return P.canvas();
  },

  /** A Mystery Dungeon trap. Variant: 0 poison · 1 sticky · 2 explosive. */
  trap(_B, variant) {
    const P = makePix(14, 14);
    const COL = at(
      [
        ['#b45ec4', '#e6a3f0'],
        ['#8bd94a', '#d2ff9a'],
        ['#ff7b3d', '#ffd08a'],
      ],
      variant,
    );
    const c = pack(COL[0]!);
    const l = pack(COL[1]!);
    const base = pack('#2a2238');
    const baseL = pack('#3b3150');
    for (let y = 1; y < 13; y++)
      for (let x = 1; x < 13; x++) {
        const edge = x === 1 || y === 1 || x === 12 || y === 12;
        P.set(x, y, edge ? c : (x + y) % 2 ? base : baseL);
      }
    const sym = at(
      [
        // poison: a skull of dots
        [
          [5, 4],
          [6, 4],
          [7, 4],
          [8, 4],
          [4, 5],
          [9, 5],
          [4, 6],
          [6, 6],
          [7, 6],
          [9, 6],
          [5, 7],
          [8, 7],
          [5, 8],
          [6, 8],
          [7, 8],
          [8, 8],
          [5, 9],
          [8, 9],
        ],
        // sticky: drops
        [
          [4, 4],
          [4, 5],
          [3, 6],
          [5, 6],
          [4, 7],
          [8, 5],
          [8, 6],
          [7, 7],
          [9, 7],
          [8, 8],
          [6, 9],
          [5, 10],
          [7, 10],
          [6, 11],
        ],
        // explosive: a mine
        [
          [6, 3],
          [7, 3],
          [5, 4],
          [8, 4],
          [4, 5],
          [9, 5],
          [4, 6],
          [6, 6],
          [7, 6],
          [9, 6],
          [4, 7],
          [6, 7],
          [7, 7],
          [9, 7],
          [4, 8],
          [9, 8],
          [5, 9],
          [8, 9],
          [6, 10],
          [7, 10],
        ],
      ],
      variant,
    );
    for (const [x, y] of sym) P.set(x!, y!, l);
    outline(P, pack('#0c0812'));
    return P.canvas();
  },

  /** The rift to the legendary's arena. Variant = frame 0–3. */
  rift(_B, variant) {
    const P = makePix(30, 46);
    const glow = pack('#7b3cff');
    const mid = pack('#b48aff');
    const core = pack('#140a26');
    const white = pack('#f2e6ff');
    for (let y = 2; y < 44; y++) {
      const t = (y - 2) / 42;
      const w = Math.sin(t * Math.PI) * 9 + 1;
      const off = Math.round(Math.sin(t * 9 + variant * 1.6) * 2.2 + (H(y, variant, 91) - 0.5) * 2);
      for (let x = -Math.ceil(w) - 2; x <= Math.ceil(w) + 2; x++) {
        const ax = Math.abs(x) / w;
        const px = 15 + x + off;
        if (ax <= 0.45) P.set(px, y, core);
        else if (ax <= 0.75) P.set(px, y, H(px, y, 92 + variant) < 0.15 ? white : mid);
        else if (ax <= 1.15 || H(px, y, 93 + variant) < 0.3) P.set(px, y, glow);
      }
    }
    // Sparks in the middle.
    for (let i = 0; i < 6; i++)
      P.set(13 + Math.floor(H(i, variant, 94) * 5), 8 + Math.floor(H(i, variant, 95) * 30), white);
    return P.canvas();
  },

  chest() {
    const P = makePix(16, 14);
    const gold = pack('#f2c443');
    const goldD = pack('#b5832a');
    const wood = pack('#8a4f2a');
    const woodD = pack('#5e3418');
    const lid = pack('#c4662e');
    for (let y = 2; y < 13; y++)
      for (let x = 1; x < 15; x++) {
        let c = y < 6 ? lid : wood;
        if (y === 6) c = goldD;
        if (x === 1 || x === 14) c = woodD;
        if ((x === 4 || x === 11) && y > 1) c = y < 6 ? gold : goldD;
        if (y === 12) c = woodD;
        P.set(x, y, c);
      }
    for (let x = 6; x < 10; x++)
      for (let y = 5; y < 9; y++) P.set(x, y, (x + y) % 3 ? gold : goldD);
    outline(P, pack('#2a160a'));
    return P.canvas();
  },
};

function paintCrystal(B: BiomePalette): HTMLCanvasElement {
  const P = makePix(26, 40);
  const L = B.leaf.map((h) => pack(h));
  const D = B.trunk.map((h) => pack(h));
  const spires = [
    [13, 2, 5, 38],
    [7, 14, 4, 38],
    [19, 12, 4, 38],
  ] as const;
  for (const [cx, top, half, bot] of spires) {
    for (let y = top; y <= bot; y++) {
      const t = Math.min(1, (y - top) / 8);
      const hw = Math.round(half * t);
      for (let x = cx - hw; x <= cx + hw; x++) {
        const side = x < cx ? (x === cx - hw ? 3 : 2) : x === cx ? 1 : 0;
        P.set(x, y, side >= 2 ? at(L, side) : y > bot - 4 ? at(D, 1) : at(L, side));
      }
    }
  }
  outline(P, at(D, 0));
  return P.canvas();
}

function paintDeadTree(B: BiomePalette): HTMLCanvasElement {
  const P = makePix(28, 40);
  const Tr = B.trunk.map((h) => pack(h));
  const L = B.leaf.map((h) => pack(h));
  for (let y = 12; y < 38; y++) for (let x = 12; x < 16; x++) P.set(x, y, at(Tr, x < 14 ? 0 : 1));
  const branch = (x0: number, y0: number, dx: number, len: number) => {
    for (let i = 0; i < len; i++) {
      P.set(x0 + dx * i, y0 - i, at(L, 1));
      P.set(x0 + dx * i, y0 - i + 1, at(L, 0));
    }
  };
  branch(12, 20, -1, 9);
  branch(15, 17, 1, 10);
  branch(13, 13, -1, 7);
  branch(14, 12, 1, 6);
  outline(P, pack('#0f0b09'));
  return P.canvas();
}
