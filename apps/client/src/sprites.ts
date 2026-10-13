// Pokémon sprites in the Mystery Dungeon style (port of legacy core/sprites.js): SpriteCollab sheets
// under `/sprites/{dex}/[s/]{Animation}.png`, geometry from the sprite manifest
// (`@pokesurvivor/data/sprites`, loaded lazily: it's large).
//
//   columns = frames · rows = 8 directions
//   0 Down · 1 DownRight · 2 Right · 3 UpRight · 4 Up · 5 UpLeft · 6 Left · 7 DownLeft
//
// Each animation has its own frame size, so they're aligned by their ground anchor: that pixel is
// always at the entity's feet and the sprite doesn't jump when Walk turns into Attack.
import type { AnimationName, PokemonSprites, SpriteAnimation } from '@pokesurvivor/data';
import type { SpriteData } from '@pokesurvivor/data/sprites';

/** World units per art pixel. Tiles and sprites share it. */
export const PX = 2;
export const ANIMATIONS: readonly AnimationName[] = [
  'Idle',
  'Walk',
  'Attack',
  'Shoot',
  'Charge',
  'Hurt',
  'Faint',
];

let manifest: SpriteData | null = null;
let loading: Promise<SpriteData> | null = null;

/** Loads and validates the sprite manifest (once). Everything else needs it. */
export function initSprites(): Promise<SpriteData> {
  loading ??= import('@pokesurvivor/data/sprites').then((m) => {
    manifest = m.loadSpriteManifest();
    return manifest;
  });
  return loading;
}

export const spritesReady = (): boolean => manifest !== null;

function meta(dex: number): PokemonSprites | null {
  return manifest?.byDex.get(dex) ?? null;
}

export const hasShiny = (dex: number): boolean => !!meta(dex)?.shiny;
export const hovers = (dex: number): boolean => !!meta(dex)?.hovers;

/** The animation's geometry (the shiny one only differs in rare cases). */
export function animMeta(dex: number, anim: AnimationName, shiny = false): SpriteAnimation | null {
  const m = meta(dex);
  if (!m) return null;
  const s = shiny && m.shiny;
  return (s ? m.shinyAnimations?.[anim] : undefined) ?? m.animations[anim] ?? null;
}

interface Sheet {
  img: HTMLImageElement;
  ready: boolean;
  failed: boolean;
  tries: number;
  retryAt: number;
  at: number;
  src: string;
}

const sheets = new Map<string, Sheet>();
// At most this many sheets in memory: hour-long runs see hundreds of species, and keeping all of
// them filled the GPU memory until the browser reloaded the page.
const MAX_SHEETS = 200;
const IDLE_MS = 20000;

function evict(now: number): void {
  const old = [...sheets].filter(([, s]) => now - s.at > IDLE_MS).sort((a, b) => a[1].at - b[1].at);
  const drop = old.slice(0, Math.max(sheets.size - Math.floor(MAX_SHEETS * 0.75), 0));
  for (const [k, s] of drop) {
    sheets.delete(k);
    s.img.onload = s.img.onerror = null;
    s.img.src = '';
  }
}

function sheet(dex: number, anim: AnimationName, shiny = false): Sheet | null {
  const m = meta(dex);
  if (!m || !manifest) return null;
  const s = shiny && m.shiny;
  const k = `${dex}/${anim}${s ? '/s' : ''}`;
  const now = performance.now();
  const sh = sheets.get(k);
  if (sh) {
    sh.at = now;
    // A failed download (bad network, busy server) is retried later.
    if (sh.failed && now > sh.retryAt) {
      sh.failed = false;
      sh.img.src = `${sh.src}&r=${sh.tries}`;
    }
    return sh;
  }
  if (sheets.size >= MAX_SHEETS) evict(now);
  const src = sheetUrl(dex, anim, s)!;
  const created: Sheet = {
    img: new Image(),
    ready: false,
    failed: false,
    tries: 0,
    retryAt: 0,
    at: now,
    src,
  };
  created.img.onload = () => (created.ready = true);
  created.img.onerror = () => {
    created.failed = true;
    created.retryAt = performance.now() + 1000 * Math.min(8, 2 ** created.tries++);
  };
  created.img.src = src;
  sheets.set(k, created);
  return created;
}

/**
 * Loads every animation of these Pokémon. Resolves when all are loaded or failed, or after
 * `timeoutMs`; `progress(done, total)` reports along the way.
 */
export async function preloadSprites(
  list: readonly { dex: number; shiny?: boolean }[],
  progress?: (done: number, total: number) => void,
  timeoutMs = 12000,
): Promise<void> {
  await initSprites();
  const all: Sheet[] = [];
  for (const { dex, shiny } of list)
    for (const a of ANIMATIONS) {
      const s = sheet(dex, a, shiny);
      if (s) all.push(s);
    }
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const check = () => {
      const done = all.filter((s) => s.ready || s.failed).length;
      progress?.(done, all.length);
      if (done === all.length || performance.now() - t0 > timeoutMs) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

/** The URL of an animation's sheet (null until the manifest is loaded, or for an unknown dex). */
export function sheetUrl(dex: number, anim: AnimationName, shiny = false): string | null {
  const m = meta(dex);
  if (!m || !manifest) return null;
  return `${manifest.basePath}/${dex}/${shiny && m.shiny ? 's/' : ''}${anim}.png?v=${m.hash}`;
}

/** Screen angle (atan2(dy, dx)) → direction row 0–7. */
export function dirFromAngle(a: number): number {
  return ((Math.round((Math.PI / 2 - a) / (Math.PI / 4)) % 8) + 8) % 8;
}

/** Visual height (for health bars and damage numbers). */
export function bodyHeight(dex: number, scale = 1): number {
  return (animMeta(dex, 'Idle')?.anchorY ?? 24) * PX * scale;
}

/** An elliptical shadow under the feet, sized by PMD's ShadowSize. */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  dex: number,
  x: number,
  y: number,
  scale = 1,
): void {
  const s = meta(dex)?.shadowSize ?? 1;
  const rx = ([5, 8, 12][Math.max(0, Math.min(2, s))] ?? 8) * PX * scale;
  ctx.fillStyle = 'rgba(0,0,0,.34)';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, rx * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The white version of an image (the hit flash), made once per sheet with "source-in": much
 * cheaper than `ctx.filter` on every draw with many enemies.
 */
const whites = new WeakMap<CanvasImageSource, HTMLCanvasElement>();
export function whiteOf(img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  let c = whites.get(img);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const x = c.getContext('2d');
  if (x) {
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, c.width, c.height);
  }
  whites.set(img, c);
  return c;
}

export interface DrawOptions {
  /** White flash: full (enemies) or soft, half white on top (players). */
  flash?: boolean;
  softFlash?: boolean;
  alpha?: number;
  /** Fallback dot colour while the sheet loads. */
  color?: string;
}

/**
 * Plays a Pokémon's animations.
 *   loop(anim)        background animation (Idle / Walk); doesn't restart if already playing
 *   play(anim, opts)  one-shot animation (Attack, Shoot, Hurt…) over the background one
 */
export class Animator {
  readonly shiny: boolean;
  base: AnimationName = 'Idle';
  cur: AnimationName = 'Idle';
  frame = 0;
  /** Time in the current frame, in 1/60 s. */
  t = 0;
  speed = 1;
  once = false;
  /** Stay on the last frame (Faint). */
  hold = false;
  done = false;
  dir = 0;

  constructor(
    readonly dex: number,
    readonly scale = 1,
    shiny = false,
  ) {
    this.shiny = shiny && hasShiny(dex);
  }

  loop(anim: AnimationName, speed = 1): void {
    this.base = anim;
    if (!this.once && this.cur !== anim) this.start(anim, false);
    if (!this.once) this.speed = speed;
  }

  play(anim: AnimationName, opts: { speed?: number; hold?: boolean } = {}): void {
    this.start(anim, true);
    this.speed = opts.speed ?? 1;
    this.hold = !!opts.hold;
  }

  /** A one-shot animation is playing. */
  busy(): boolean {
    return this.once && !this.done;
  }

  /** 0–1 through the current animation. */
  progress(): number {
    const m = animMeta(this.dex, this.cur, this.shiny);
    if (!m) return 1;
    let total = 0;
    let before = 0;
    m.durations.forEach((d, i) => {
      if (i < this.frame) before += d;
      total += d;
    });
    return total ? (before + this.t) / total : 1;
  }

  /** Seconds the animation lasts at speed 1. */
  length(anim: AnimationName): number {
    const m = animMeta(this.dex, anim, this.shiny);
    return m ? m.durations.reduce((a, b) => a + b, 0) / 60 : 0.4;
  }

  private start(anim: AnimationName, once: boolean): void {
    this.cur = anim;
    this.frame = 0;
    this.t = 0;
    this.once = once;
    this.done = false;
    this.hold = false;
  }

  update(dt: number): void {
    const m = animMeta(this.dex, this.cur, this.shiny);
    if (!m || this.done) return;
    this.t += dt * 60 * this.speed;
    for (;;) {
      const d = m.durations[this.frame] ?? 1;
      if (this.t < d) break;
      this.t -= d;
      this.frame++;
      if (this.frame >= m.frames) {
        if (this.once) {
          if (this.hold) {
            this.frame = m.frames - 1;
            this.done = true;
            return;
          }
          // Back to the background animation.
          this.start(this.base, false);
          this.speed = 1;
          return;
        }
        this.frame = 0;
      }
    }
  }

  /** Draws with the feet at (x, y). */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, opts: DrawOptions = {}): void {
    let anim = this.cur;
    let s = sheet(this.dex, anim, this.shiny);
    // While this animation loads, show Idle if that's ready.
    if (s && !s.ready) {
      const idle = sheet(this.dex, 'Idle', this.shiny);
      if (idle?.ready) {
        s = idle;
        anim = 'Idle';
      }
    }
    const m = animMeta(this.dex, anim, this.shiny);
    const k = PX * this.scale;
    if (!m || !s || !s.ready) {
      // Fallback: a dot, in case the file is missing.
      ctx.fillStyle = opts.color ?? '#6b7a94';
      ctx.beginPath();
      ctx.arc(x, y - 12 * k, 8 * k, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const frame = anim === this.cur ? Math.min(this.frame, m.frames - 1) : 0;
    const row = Math.min(this.dir, m.rows - 1);
    const alpha = opts.alpha ?? 1;
    if (alpha <= 0) return;
    const sx = frame * m.width;
    const sy = row * m.height;
    const dx = Math.round(x - m.anchorX * k);
    const dy = Math.round(y - m.anchorY * k);
    const prev = ctx.globalAlpha;
    if (alpha < 1) ctx.globalAlpha = prev * alpha;
    if (!opts.flash || opts.softFlash)
      ctx.drawImage(s.img, sx, sy, m.width, m.height, dx, dy, m.width * k, m.height * k);
    if (opts.flash) {
      if (opts.softFlash) ctx.globalAlpha = prev * alpha * 0.55;
      ctx.drawImage(whiteOf(s.img), sx, sy, m.width, m.height, dx, dy, m.width * k, m.height * k);
    }
    ctx.globalAlpha = prev;
  }
}

export interface SpriteBox {
  width: number;
  height: number;
}

/**
 * The pixel scale for a sprite frame to fit `box`: `scale` if it fits, else the largest whole
 * scale that does (crisp pixels), or a fraction below 1 for the rare frame that doesn't fit even
 * at 1. The height that counts is the body above the feet (`anchorY`); below them is empty.
 */
export function fitScale(
  frame: { width: number; anchorY: number },
  scale: number,
  box?: SpriteBox,
): number {
  if (!box) return scale;
  const max = Math.min(box.width / frame.width, box.height / frame.anchorY);
  if (max >= scale) return scale;
  return max >= 1 ? Math.floor(max) : max;
}
