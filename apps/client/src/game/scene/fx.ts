// Particles, damage numbers and effects in pixel art (port of legacy entities/fx.js). Purely
// visual: driven by sim events and the renderer, never by gameplay. Everything is drawn on the
// game's pixel grid (PX): particles are squares, rings are dots, and hits and beams are built from
// blocks and the VFX sprites, to match the Mystery Dungeon sprites.
import { drawTwinkle } from '../../icons.js';
import { settings } from '../../settings.js';
import { PX } from '../../sprites.js';
import { hash2 } from '@pokesurvivor/sim';
import { fxLevel } from './quality.js';
import { PAL, drawVfx, type MoveVis } from './vfx.js';

// Caps by quality: low, medium, high.
const CAP_PARTS = [350, 800, 1400];
const CAP_SPRITES = [110, 210, 320];
const CAP_TEXTS = [25, 45, 70];
const DENS = [0.35, 0.65, 1];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const snap = (v: number) => Math.round(v / PX) * PX;
// Transparency goes in steps (1 · .66 · .33) so it doesn't look vector-drawn.
const step = (k: number) => (k > 0.66 ? 1 : k > 0.33 ? 0.66 : 0.33);

interface Part {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  color: string;
  s: number;
  grav: number;
  drag: number;
}
interface Sprite {
  shape: string;
  pal: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  scale: number;
  angle: number;
  spin: number;
  grav: number;
  fr: number;
  fade: boolean;
  twinkle?: boolean;
}
interface Text {
  x: number;
  y: number;
  vy: number;
  t: number;
  life: number;
  s: string;
  color: string;
  big: boolean;
}
interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  color: string;
  life: number;
  t: number;
  width: number;
}
interface Slash {
  x: number;
  y: number;
  angle: number;
  radius: number;
  arc: number;
  pal: string;
  t: number;
  life: number;
}
interface Beam {
  x: number;
  y: number;
  angle: number;
  len: number;
  width: number;
  pal: string;
  shape: string | null;
  t: number;
  life: number;
  seed: number;
}

export interface PxOptions {
  vx?: number;
  vy?: number;
  life?: number;
  /** In art pixels. */
  size?: number;
  grav?: number;
  drag?: number;
}

export interface SpriteOptions {
  vx?: number;
  vy?: number;
  life?: number;
  scale?: number;
  angle?: number;
  spin?: number;
  grav?: number;
  frameRate?: number;
  fade?: boolean;
}

export class FX {
  private parts: Part[] = [];
  private sprites: Sprite[] = [];
  private texts: Text[] = [];
  private rings: Ring[] = [];
  private slashes: Slash[] = [];
  private beams: Beam[] = [];

  clear(): void {
    this.parts = [];
    this.sprites = [];
    this.texts = [];
    this.rings = [];
    this.slashes = [];
    this.beams = [];
  }

  get count(): number {
    return this.parts.length + this.sprites.length + this.texts.length;
  }

  px(x: number, y: number, color: string, o: PxOptions = {}): void {
    if (this.parts.length >= CAP_PARTS[fxLevel()]!) return;
    this.parts.push({
      x,
      y,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0,
      t: 0,
      life: o.life ?? 0.4,
      color,
      s: (o.size ?? 1) * PX,
      grav: o.grav ?? 0,
      drag: o.drag ?? 0.9,
    });
  }

  burst(x: number, y: number, color: string, n = 8, power = 110): void {
    n = Math.max(1, Math.round(n * DENS[fxLevel()]!));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(power * 0.35, power);
      this.px(x, y, color, {
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: rand(0.22, 0.5),
        size: Math.random() < 0.35 ? 2 : 1,
      });
    }
  }

  spark(x: number, y: number, color: string, dirX: number, dirY: number, n = 4): void {
    n = Math.max(1, Math.round(n * DENS[fxLevel()]!));
    const base = Math.atan2(dirY, dirX);
    for (let i = 0; i < n; i++) {
      const a = base + rand(-0.9, 0.9);
      const s = rand(60, 170);
      this.px(x, y, color, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.14, 0.32) });
    }
  }

  /** A loose effect sprite. */
  sp(shape: string, pal: string, x: number, y: number, o: SpriteOptions = {}): void {
    if (this.sprites.length >= CAP_SPRITES[fxLevel()]!) return;
    this.sprites.push({
      shape,
      pal,
      x,
      y,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0,
      t: 0,
      life: o.life ?? 0.4,
      scale: o.scale ?? 1,
      angle: o.angle ?? 0,
      spin: o.spin ?? 0,
      grav: o.grav ?? 0,
      fr: o.frameRate ?? 10,
      fade: o.fade !== false,
    });
  }

  /** The shiny sparkle (a pixel cross that appears and fades). */
  twinkle(x: number, y: number): void {
    if (this.sprites.length >= CAP_SPRITES[fxLevel()]!) return;
    this.sprites.push({
      twinkle: true,
      shape: '',
      pal: '',
      x,
      y,
      vx: 0,
      vy: -8,
      t: 0,
      life: rand(0.45, 0.7),
      scale: 1,
      angle: 0,
      spin: 0,
      grav: 0,
      fr: 0,
      fade: false,
    });
  }

  /** Projectile trail particles, by material. */
  trail(kind: string, pal: string, x: number, y: number, vx: number, vy: number): void {
    if (Math.random() > DENS[fxLevel()]!) return;
    const P = PAL[pal] ?? PAL.normal!;
    const back = Math.atan2(-vy, -vx);
    const j = () => rand(-3, 3);
    const c = (i: number) => P[i] ?? '#fff';
    switch (kind) {
      case 'ember':
        return this.px(x + j(), y + j(), c(Math.random() < 0.5 ? 3 : 2), {
          vx: Math.cos(back) * 30,
          vy: -40,
          life: 0.35,
        });
      case 'drip':
        return this.px(x + j(), y + j(), c(3), {
          vx: Math.cos(back) * 20,
          vy: 10,
          grav: 260,
          life: 0.35,
        });
      case 'spark':
        return this.px(x + j() * 2, y + j() * 2, Math.random() < 0.5 ? c(4) : c(3), {
          vx: rand(-60, 60),
          vy: rand(-60, 60),
          life: 0.16,
        });
      case 'bubbles':
        return this.px(x + j(), y + j(), c(3), {
          vy: -35,
          life: 0.45,
          size: Math.random() < 0.3 ? 2 : 1,
        });
      case 'dirt':
        return this.px(x + j(), y + j(), c(Math.random() < 0.5 ? 2 : 1), {
          vx: Math.cos(back) * 25,
          vy: -20,
          grav: 300,
          life: 0.35,
        });
      case 'wisp':
        return this.px(x + j() * 2, y + j() * 2, c(Math.random() < 0.5 ? 1 : 2), {
          vy: -30,
          life: 0.5,
          size: 2,
        });
    }
  }

  /**
   * A floating number or label. Numbers (and "-12") are hidden when damage numbers are off in the
   * settings; text notices are not. With hundreds of hits a second they're capped (big ones always
   * get in).
   */
  text(x: number, y: number, value: string | number, color = '#ffffff', big = false): void {
    const s = String(value);
    if ((typeof value === 'number' || /^[-+]?\d/.test(s)) && !settings.get().damageNumbers) return;
    if (this.texts.length >= CAP_TEXTS[fxLevel()]!) {
      if (!big) return;
      this.texts.shift();
    }
    this.texts.push({
      x: x + rand(-6, 6),
      y,
      vy: -46,
      t: 0,
      life: big ? 0.95 : 0.62,
      s,
      color,
      big,
    });
  }

  /** A shock-wave ring (pixel dots). */
  ring(x: number, y: number, r0: number, r1: number, color: string, life = 0.3, width = 3): void {
    this.rings.push({ x, y, r0, r1, color, life, t: 0, width });
  }

  /** A melee hit, with the move's extra (impact, jaws, claw, vine, feather). */
  slash(x: number, y: number, angle: number, radius: number, arc: number, vis: Partial<MoveVis>) {
    const pal = vis.pal ?? 'normal';
    this.slashes.push({ x, y, angle, radius, arc, pal, t: 0, life: 0.22 });
    const mx = x + Math.cos(angle) * radius * 0.7;
    const my = y + Math.sin(angle) * radius * 0.7;
    switch (vis.melee) {
      case 'impact':
        return this.sp('impact', pal, mx, my, {
          life: 0.2,
          scale: 1.5,
          frameRate: 12,
          fade: false,
        });
      case 'jaws':
        return this.sp('jaws', pal, mx, my, { life: 0.24, scale: 1.5, frameRate: 9, fade: false });
      case 'claw':
        return this.sp('claw', pal, mx, my, { life: 0.2, scale: 1.5, angle: angle - Math.PI / 4 });
      case 'vine':
      case 'feather':
        for (let i = 0; i < 4; i++) {
          const a = angle + rand(-arc / 2, arc / 2);
          const r = radius * rand(0.5, 1);
          this.sp(
            'leaf',
            vis.melee === 'feather' ? 'flying' : pal,
            x + Math.cos(a) * r,
            y + Math.sin(a) * r,
            {
              vx: Math.cos(a) * 40,
              vy: Math.sin(a) * 40 + 20,
              life: 0.45,
              spin: rand(-8, 8),
              grav: 60,
            },
          );
        }
    }
  }

  /** A straight beam; `vis.beam` is the shape travelling along it, or `lightning`. */
  beam(x: number, y: number, angle: number, len: number, width: number, vis: Partial<MoveVis>) {
    const pal = vis.pal ?? 'normal';
    this.beams.push({
      x,
      y,
      angle,
      len,
      width,
      pal,
      shape: vis.beam ?? null,
      t: 0,
      life: 0.2,
      seed: Math.random() * 100,
    });
    this.sp('impact', pal, x + Math.cos(angle) * 10, y + Math.sin(angle) * 10, {
      life: 0.12,
      scale: 1,
    });
    this.sp('impact', pal, x + Math.cos(angle) * len, y + Math.sin(angle) * len, {
      life: 0.18,
      scale: 1.5,
    });
  }

  update(dt: number): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]!;
      p.t += dt;
      if (p.t >= p.life) {
        this.parts.splice(i, 1);
        continue;
      }
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = Math.pow(p.drag, dt * 60);
      p.vx *= k;
      p.vy *= k;
    }
    for (let i = this.sprites.length - 1; i >= 0; i--) {
      const s = this.sprites[i]!;
      s.t += dt;
      if (s.t >= s.life) {
        this.sprites.splice(i, 1);
        continue;
      }
      s.vy += s.grav * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      if (s.spin) s.angle += s.spin * dt;
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i]!;
      t.t += dt;
      if (t.t >= t.life) {
        this.texts.splice(i, 1);
        continue;
      }
      t.y += t.vy * dt;
      t.vy *= 0.94;
    }
    for (const arr of [this.rings, this.slashes, this.beams] as { t: number; life: number }[][]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const e = arr[i]!;
        e.t += dt;
        if (e.t >= e.life) arr.splice(i, 1);
      }
    }
  }

  private drawBeam(ctx: CanvasRenderingContext2D, b: Beam, now: number): void {
    const k = 1 - b.t / b.life;
    const P = PAL[b.pal] ?? PAL.normal!;
    const a = Math.round(b.angle / (Math.PI / 16)) * (Math.PI / 16);
    ctx.save();
    ctx.translate(snap(b.x), snap(b.y));
    ctx.rotate(a);
    ctx.globalAlpha = step(k);
    const seg = PX * 2;
    if (b.shape === 'lightning') {
      // A zigzag redrawn every frame.
      let py = 0;
      for (let d = 0; d < b.len; d += seg) {
        const ny =
          d + seg >= b.len ? 0 : snap((hash2(d | 0, (now * 30) | 0, b.seed | 0) - 0.5) * b.width);
        const lo = Math.min(py, ny);
        const hi = Math.max(py, ny);
        ctx.fillStyle = P[3]!;
        ctx.fillRect(d - PX, lo - PX * 2, seg + PX * 2, hi - lo + PX * 4);
        ctx.fillStyle = P[4]!;
        ctx.fillRect(d, lo - PX, seg, hi - lo + PX * 2);
        py = ny;
      }
    } else {
      // The beam's body in blocks, with a wobbling edge.
      for (let d = 0; d < b.len; d += seg) {
        const wob = 0.7 + 0.3 * Math.sin(d * 0.18 + now * 30 + b.seed);
        const hw = Math.max(PX, snap((b.width / 2) * wob * (0.6 + 0.4 * k)));
        ctx.fillStyle = P[1]!;
        ctx.fillRect(d, -hw - PX, seg, hw * 2 + PX * 2);
        ctx.fillStyle = P[2]!;
        ctx.fillRect(d, -hw, seg, hw * 2);
        ctx.fillStyle = P[3]!;
        ctx.fillRect(d, -snap(hw * 0.55), seg, snap(hw * 0.55) * 2);
        ctx.fillStyle = P[4]!;
        ctx.fillRect(d, -PX, seg, PX * 2);
      }
      // Sprites travelling along the beam (flames, drops, crystals, waves).
      if (b.shape) {
        const gap = 26;
        const off = (now * 420) % gap;
        for (let d = off; d < b.len - 6; d += gap) {
          const yo = Math.sin(d * 0.3 + b.seed) * b.width * 0.18;
          drawVfx(ctx, b.shape, b.pal, d, yo, {
            angle: 0.0001,
            scale: 1.5,
            frame: (d / gap + now * 12) | 0,
          });
        }
      }
    }
    ctx.restore();
  }

  private drawSlash(ctx: CanvasRenderingContext2D, s: Slash): void {
    const k = 1 - s.t / s.life;
    const P = PAL[s.pal] ?? PAL.normal!;
    const half = Math.min(s.arc, Math.PI * 2) / 2;
    const r = s.radius * (0.72 + 0.28 * (1 - k));
    const n = Math.max(8, Math.ceil((r * half * 2) / PX));
    ctx.globalAlpha = step(k);
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const a = s.angle - half + u * half * 2;
      const thick = Math.round(Math.sin(Math.PI * u) * 3 * k); // in art pixels
      for (let j = -1; j <= thick; j++) {
        const rr = r - j * PX;
        ctx.fillStyle = (j < 0 ? P[1] : j === thick ? P[4] : j > thick / 2 ? P[3] : P[2])!;
        ctx.fillRect(snap(s.x + Math.cos(a) * rr), snap(s.y + Math.sin(a) * rr), PX, PX);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawRing(ctx: CanvasRenderingContext2D, r: Ring): void {
    const k = r.t / r.life;
    const rad = r.r0 + (r.r1 - r.r0) * k;
    const n = Math.max(10, Math.ceil((rad * Math.PI * 2) / (PX * 2)));
    const size = r.width >= 4 ? PX * 2 : PX;
    ctx.globalAlpha = step(1 - k);
    ctx.fillStyle = r.color;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.fillRect(snap(r.x + Math.cos(a) * rad), snap(r.y + Math.sin(a) * rad * 0.9), size, size);
    }
    ctx.globalAlpha = 1;
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    for (const b of this.beams) this.drawBeam(ctx, b, now);
    for (const s of this.slashes) this.drawSlash(ctx, s);
    for (const r of this.rings) this.drawRing(ctx, r);
    for (const p of this.parts) {
      ctx.globalAlpha = step(1 - p.t / p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(snap(p.x), snap(p.y), p.s, p.s);
    }
    ctx.globalAlpha = 1;
    for (const s of this.sprites) {
      const k = 1 - s.t / s.life;
      if (s.twinkle) {
        drawTwinkle(ctx, s.x, s.y, s.t / s.life, PX);
        continue;
      }
      drawVfx(ctx, s.shape, s.pal, s.x, s.y, {
        angle: s.angle,
        scale: s.scale,
        alpha: s.fade ? step(k) : 1,
        frame: Math.floor(s.t * s.fr),
      });
    }
    // Damage numbers.
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    for (const t of this.texts) {
      const k = 1 - t.t / t.life;
      ctx.globalAlpha = Math.min(1, k * 2.2);
      ctx.font = `${t.big ? '700 20px' : '700 13px'} Pixelify,"Segoe UI",sans-serif`;
      ctx.strokeText(t.s, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.s, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }
}
