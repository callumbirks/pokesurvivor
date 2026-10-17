// Pokémon sprites in the Mystery Dungeon style (port of original implementation): SpriteCollab sheets
// under `/sprites/{dex}/[s/]{Animation}.png`, geometry from the sprite manifest
// (`@pokesurvivor/data/sprites`, loaded lazily: it's large).
//
//   columns = frames · rows = 8 directions
//   0 Down · 1 DownRight · 2 Right · 3 UpRight · 4 Up · 5 UpLeft · 6 Left · 7 DownLeft
//
// Each animation has its own frame size, so they're aligned by their ground anchor: that pixel is
// always at the entity's feet and the sprite doesn't jump when Walk turns into Attack.
//
// A sprite is a dex, or the key of an alternate form (`"6-mega"`: megas.json, the sheets under
// `/sprites/6-mega/`). Forms can lack animations; asking for one gives the closest it has
// (`ANIM_FALLBACKS`): no Faint holds Hurt (the caller fades it, `hasAnim`), no Shoot attacks.
import {
  formKey,
  type AnimationName,
  type PokemonSprites,
  type SpriteAnimation,
} from '@pokesurvivor/data';
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

/** A dex (the base form), or an alternate form's sprite key (`"6-mega"`). */
export type SpriteRef = number | string;

/** The sprite of a Pokémon's Mega (Primal, Crowned) form. */
export const megaSpriteRef = (dex: number, kind: string): SpriteRef => formKey(dex, kind);

/**
 * What to draw for an animation a sheet set lacks, in order (some alternate forms have no Faint,
 * Shoot or Hurt). The last resort is Idle, which every sprite has.
 */
export const ANIM_FALLBACKS: Readonly<Record<AnimationName, readonly AnimationName[]>> = {
  Idle: ['Walk'],
  Walk: ['Idle'],
  Attack: ['Charge', 'Shoot'],
  Shoot: ['Attack', 'Charge'],
  Charge: ['Attack', 'Shoot'],
  Hurt: ['Idle'],
  Faint: ['Hurt'],
};

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

function meta(ref: SpriteRef): PokemonSprites | null {
  return (typeof ref === 'number' ? manifest?.byDex.get(ref) : manifest?.byKey.get(ref)) ?? null;
}

export const hasShiny = (ref: SpriteRef): boolean => !!meta(ref)?.shiny;
export const hovers = (ref: SpriteRef): boolean => !!meta(ref)?.hovers;
/** The sprite has this animation's own sheet (not a fallback). */
export const hasAnim = (ref: SpriteRef, anim: AnimationName): boolean =>
  !!meta(ref)?.animations[anim];

/** The animation drawn for `anim`: itself, or its fallback (`ANIM_FALLBACKS`). */
export function resolveAnim(ref: SpriteRef, anim: AnimationName): AnimationName {
  const m = meta(ref);
  if (!m || m.animations[anim]) return anim;
  return ANIM_FALLBACKS[anim].find((a) => m.animations[a]) ?? 'Idle';
}

/** The animation's geometry (the shiny one only differs in rare cases), fallbacks resolved. */
export function animMeta(
  ref: SpriteRef,
  anim: AnimationName,
  shiny = false,
): SpriteAnimation | null {
  const m = meta(ref);
  if (!m) return null;
  const a = resolveAnim(ref, anim);
  const s = shiny && m.shiny;
  return (s ? m.shinyAnimations?.[a] : undefined) ?? m.animations[a] ?? null;
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

function sheet(ref: SpriteRef, requested: AnimationName, shiny = false): Sheet | null {
  const m = meta(ref);
  if (!m || !manifest) return null;
  const anim = resolveAnim(ref, requested);
  const s = shiny && m.shiny;
  const k = `${ref}/${anim}${s ? '/s' : ''}`;
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
  const src = sheetUrl(ref, anim, s)!;
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
  list: readonly { dex: SpriteRef; shiny?: boolean }[],
  progress?: (done: number, total: number) => void,
  timeoutMs = 12000,
): Promise<void> {
  await initSprites();
  const all: Sheet[] = [];
  for (const { dex, shiny } of list)
    for (const a of ANIMATIONS) {
      // A fallback is the same sheet as the animation it falls back to.
      if (!hasAnim(dex, a)) continue;
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
export function sheetUrl(ref: SpriteRef, anim: AnimationName, shiny = false): string | null {
  const m = meta(ref);
  if (!m || !manifest) return null;
  const a = resolveAnim(ref, anim);
  return `${manifest.basePath}/${ref}/${shiny && m.shiny ? 's/' : ''}${a}.png?v=${m.hash}`;
}

/** Screen angle (atan2(dy, dx)) → direction row 0–7. */
export function dirFromAngle(a: number): number {
  return ((Math.round((Math.PI / 2 - a) / (Math.PI / 4)) % 8) + 8) % 8;
}

/**
 * `dirFromAngle`, but keeping the current row until the angle is clearly in another one, so an
 * angle on a boundary between two directions (an aim or a heading that wobbles) doesn't flicker.
 */
export function stableDir(cur: number, a: number, margin = 0.15): number {
  const next = dirFromAngle(a);
  if (next === cur) return cur;
  const center = Math.PI / 2 - (cur * Math.PI) / 4;
  const gap = Math.abs(Math.atan2(Math.sin(a - center), Math.cos(a - center)));
  return gap > Math.PI / 8 + margin ? next : cur;
}

/** Visual height (for health bars and damage numbers). */
export function bodyHeight(dex: SpriteRef, scale = 1): number {
  return (animMeta(dex, 'Idle')?.anchorY ?? 24) * PX * scale;
}

/** PMD's ShadowSize for a Pokémon (0–2), once the manifest is loaded. */
export const shadowSizeOf = (dex: SpriteRef): number | null => meta(dex)?.shadowSize ?? null;

/** An elliptical shadow under the feet, sized by PMD's ShadowSize. */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  dex: SpriteRef,
  x: number,
  y: number,
  scale = 1,
): void {
  const r = shadowRadii(meta(dex)?.shadowSize ?? 1);
  const rx = r.rx * PX * scale;
  ctx.fillStyle = 'rgba(0,0,0,.34)';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, r.ry * PX * scale, 0, 0, Math.PI * 2);
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
    readonly dex: SpriteRef,
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

/** The shadow ellipse's radii in art pixels, by PMD's ShadowSize (as `drawShadow`). */
export function shadowRadii(shadowSize: number): { rx: number; ry: number } {
  const rx = [5, 8, 12][Math.max(0, Math.min(2, shadowSize))] ?? 8;
  return { rx, ry: rx * 0.42 };
}

type Frame = Pick<SpriteAnimation, 'width' | 'height' | 'anchorX' | 'anchorY' | 'bounds'>;

/**
 * What a sprite shows inside its frame, in art pixels: the opaque pixels (`bounds`) and, with a
 * shadow, the ellipse under the feet. Art often reaches below the anchor (tails, legs), so the
 * bottom is whichever is lower.
 */
export function visualBox(frame: Frame, shadowSize: number | null) {
  const b = frame.bounds;
  const s = shadowSize === null ? null : shadowRadii(shadowSize);
  return {
    left: Math.min(b.left, s ? frame.anchorX - s.rx : b.left),
    right: Math.max(b.right, s ? frame.anchorX + s.rx : b.right),
    top: b.top,
    bottom: Math.max(b.bottom, s ? frame.anchorY + s.ry : b.bottom),
  };
}

/**
 * The pixel scale for a sprite to fit `box`: `scale` if what it shows fits, else the largest
 * whole scale that does (crisp pixels), or a fraction below 1 for the rare one that doesn't fit
 * even at 1.
 */
export function fitScale(
  frame: Frame,
  scale: number,
  box?: SpriteBox,
  shadowSize: number | null = null,
): number {
  if (!box) return scale;
  const v = visualBox(frame, shadowSize);
  const max = Math.min(box.width / (v.right - v.left), box.height / (v.bottom - v.top));
  if (max >= scale) return scale;
  return max >= 1 ? Math.floor(max) : max;
}

export interface SpriteLayout {
  scale: number;
  /** The element's size: the whole frame at `scale`. */
  width: number;
  height: number;
  /**
   * With `feet`, the margin that stands the sprite on its container's content edge: the frame's
   * empty rows below what it shows (art or shadow) hang under it, so the lowest visible pixel
   * sits on that edge, and the container's padding is the margin to its border.
   */
  marginBottom: number;
  /** What it shows, from the element's top edge (CSS px). */
  visualTop: number;
  visualBottom: number;
}

export function spriteLayout(
  frame: Frame,
  opts: { scale: number; box?: SpriteBox; shadowSize: number | null; feet: boolean },
): SpriteLayout {
  const k = fitScale(frame, opts.scale, opts.box, opts.shadowSize);
  const v = visualBox(frame, opts.shadowSize);
  return {
    scale: k,
    width: frame.width * k,
    height: frame.height * k,
    marginBottom: opts.feet ? -(frame.height - v.bottom) * k : 0,
    visualTop: v.top * k,
    visualBottom: v.bottom * k,
  };
}
