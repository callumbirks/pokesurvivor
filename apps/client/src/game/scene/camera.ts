// View and world↔screen transform (port of legacy core/camera.js). The visible world width is
// constant (VIEW_W) whatever the window size, so the game feels the same on every screen; on
// screens wider than 16:9 (phones in landscape) a minimum world height is kept too.
import { VIEW_W } from '@pokesurvivor/sim';
import { settings } from '../../settings.js';

const MIN_VIEW_H = 420;

const damp = (a: number, b: number, rate: number, dt: number) => b + (a - b) * Math.exp(-rate * dt);

export class Camera {
  x = 0;
  y = 0;
  /** CSS px per world unit. */
  scale = 1;
  /** World units visible. */
  w = VIEW_W;
  h = MIN_VIEW_H;
  dpr = 1;
  shake = 0;
  private sx = 0;
  private sy = 0;

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.scale = Math.min(cssW / VIEW_W, cssH / MIN_VIEW_H);
    this.w = cssW / this.scale;
    this.h = cssH / this.scale;
  }

  follow(tx: number, ty: number, dt: number): void {
    this.x = damp(this.x, tx, 9, dt);
    this.y = damp(this.y, ty, 9, dt);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.4);
      const a = this.shake * 7;
      this.sx = (Math.random() * 2 - 1) * a;
      this.sy = (Math.random() * 2 - 1) * a;
    } else this.sx = this.sy = 0;
  }

  /** Jumps there (a new run, a teleport). */
  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  kick(amount: number): void {
    if (settings.get().calmMode) amount *= 0.25; // "fewer shakes"
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /** Applies the camera to a context already scaled to world units. */
  apply(ctx: CanvasRenderingContext2D): void {
    // Rounded to physical pixels: without it, 1 px seams show between chunks and sprites shimmer.
    const k = this.scale * this.dpr;
    ctx.translate(
      Math.round((-this.left() + this.sx) * k) / k,
      Math.round((-this.top() + this.sy) * k) / k,
    );
  }

  left(): number {
    return this.x - this.w / 2;
  }
  top(): number {
    return this.y - this.h / 2;
  }

  /** Is the point in view (with a margin)? */
  sees(x: number, y: number, pad = 60): boolean {
    return (
      x > this.left() - pad &&
      x < this.left() + this.w + pad &&
      y > this.top() - pad &&
      y < this.top() + this.h + pad
    );
  }

  /** World → screen (CSS px). */
  toScreen(x: number, y: number): [number, number] {
    return [(x - this.left()) * this.scale, (y - this.top()) * this.scale];
  }

  /** Radius of the circle around the view (bomb rings). */
  outerRadius(): number {
    return Math.hypot(this.w, this.h) / 2 + 40;
  }
}
