// The weather on screen (the drawing half of legacy systems/weather.js): a light tint and a few
// particles, soft on purpose. The sim owns the weather itself; snapshots carry it in whole seconds,
// so the fade in and out runs on a local clock from there.
import { loadGameData, type WeatherFile } from '@pokesurvivor/data';

type WeatherKind = WeatherFile['kinds'][number];
import type { NetMisc } from '@pokesurvivor/netclient';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  c: string;
  t: number;
  life: number;
}

const WANT: Record<string, number> = { rain: 70, snow: 45, sand: 40, sun: 14, fog: 0 };
const FADE = 3;

export function weatherKind(id: string): WeatherKind | undefined {
  return loadGameData().weather.kinds.find((k) => k.id === id);
}

export class WeatherLayer {
  private parts: Particle[] = [];
  private kind: string | null = null;
  /** Seconds into the weather and how long it lasts (local, smoothed from the snapshot). */
  private t = 0;
  private dur = 0;

  /** Follows the snapshot's weather (`t` whole seconds). */
  update(w: NetMisc['weather'], dt: number): void {
    if (!w) {
      // Cleared: fade out what's left.
      if (this.kind) this.t = Math.max(this.t, this.dur - FADE) + dt;
      if (this.t >= this.dur) this.kind = null;
      return;
    }
    if (w.kind !== this.kind) {
      this.kind = w.kind;
      this.t = w.t;
      this.parts = [];
    } else {
      this.t += dt;
      // Keep within the second the snapshot says.
      if (this.t < w.t || this.t > w.t + 1.2) this.t = w.t;
    }
    this.dur = w.dur;
  }

  /** 0–1: fades in and out over 3 s. */
  level(): number {
    if (!this.kind) return 0;
    return Math.max(0, Math.min(1, this.t / FADE, (this.dur - this.t) / FADE));
  }

  get current(): { kind: string; left: number } | null {
    return this.kind && this.level() > 0
      ? { kind: this.kind, left: Math.max(0, this.dur - this.t) }
      : null;
  }

  /** Fog closes the vignette a little. */
  get fog(): number {
    return this.kind === 'fog' ? this.level() : 0;
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, dt: number): void {
    const def = this.kind ? weatherKind(this.kind) : undefined;
    const k = this.level();
    if (!def || !this.kind || k <= 0) {
      this.parts.length = 0;
      return;
    }
    const [r, g, b, a] = def.tint;
    ctx.fillStyle = `rgba(${r},${g},${b},${a * k})`;
    ctx.fillRect(0, 0, w, h);
    const want = (WANT[this.kind] ?? 0) * k * (w / 1280);
    while (this.parts.length < want) this.parts.push(this.spawn(w, h, true));
    if (this.parts.length > want + 4) this.parts.length = Math.ceil(want);
    const s = Math.max(2, Math.round(w / 640)); // one game "pixel"
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]!;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.t += dt;
      if (p.y > h + 20 || p.x < -40 || p.x > w + 40 || p.t > p.life) {
        this.parts[i] = this.spawn(w, h, false);
        continue;
      }
      ctx.globalAlpha = p.a * k;
      ctx.fillStyle = p.c;
      if (this.kind === 'rain') {
        for (let j = 0; j < 4; j++)
          ctx.fillRect(
            Math.round(p.x - j * s * 0.5),
            Math.round(p.y - j * s * 1.5),
            s * 0.5,
            s * 1.5,
          );
      } else if (this.kind === 'sand')
        ctx.fillRect(Math.round(p.x), Math.round(p.y), s * 3, s * 0.5);
      else ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    }
    ctx.globalAlpha = 1;
  }

  private spawn(w: number, h: number, anywhere: boolean): Particle {
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const y = anywhere ? Math.random() * h : -10;
    switch (this.kind) {
      case 'rain':
        return {
          x: Math.random() * (w + 200),
          y,
          vx: -120,
          vy: 720,
          a: 0.5,
          c: '#cfe2ff',
          t: 0,
          life: 9,
        };
      case 'snow':
        return {
          x: Math.random() * w,
          y,
          vx: rnd(-20, 20),
          vy: rnd(40, 80),
          a: 0.7,
          c: '#ffffff',
          t: 0,
          life: 20,
        };
      case 'sand':
        return {
          x: anywhere ? Math.random() * w : w + 20,
          y: Math.random() * h,
          vx: rnd(-520, -380),
          vy: rnd(20, 60),
          a: 0.4,
          c: '#e8cf8f',
          t: 0,
          life: 9,
        };
      default:
        // Sun: motes of light rising slowly.
        return {
          x: Math.random() * w,
          y: anywhere ? Math.random() * h : h + 5,
          vx: rnd(-8, 8),
          vy: -rnd(15, 30),
          a: 0.45,
          c: '#fff1b0',
          t: 0,
          life: 12,
        };
    }
  }
}
