// Touch controls (port of original implementation). A floating joystick: put a finger anywhere on the
// game and it appears there; drag to move; lift to hide it. If the finger goes past the radius,
// the base follows (it never gets "stuck").
//
// Manual aim (`twinSticks`): a finger on the left half moves, one on the right half aims (a second
// floating joystick). Letting go of the aim stick keeps the last aim (aim.ts holds it).
//
// HUD buttons (move icons, pause): the HUD registers them every frame with `addButton()`; a tap (or
// a mouse click) on one presses it instead of opening the joystick. Several fingers work at once.
import { settings } from '../settings.js';

interface Button {
  x: number;
  y: number;
  w: number;
  h: number;
  fn: () => void;
  pad: number;
}

interface Stick {
  id: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
}

export class TouchControls {
  /** Touch is in use (a touch was seen, or it's a touch-first device). */
  active: boolean;
  private stick: Stick | null = null;
  private aimStick: Stick | null = null;
  private buttons: Button[] = [];
  private lastKey = '';
  private lastAt = 0;
  private safe: { top: number; right: number; bottom: number; left: number } | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly el: HTMLElement,
    /** May the joystick open now (the run is playing)? */
    private readonly canMove: () => boolean,
    /** Two sticks: move on the left half, aim on the right (manual aim)? */
    private readonly twinSticks: () => boolean = () => false,
  ) {
    this.active = matchMedia('(pointer: coarse)').matches;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      ev: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(ev, fn as EventListener, opts);
      this.offs.push(() => target.removeEventListener(ev, fn as EventListener, opts));
    };
    on(el, 'pointerdown', (e) => this.down(e));
    on(el, 'pointermove', (e) => this.move(e));
    on(el, 'pointerup', (e) => this.up(e));
    on(el, 'pointercancel', (e) => this.up(e));
    on(el, 'contextmenu', (e) => e.preventDefault());
    // iPhone: a long press on the game opened the magnifier and the "Copy / Select all" menu.
    // Cancelling the touch here avoids it (pointer events, which the joystick uses, still come).
    // Buttons are pressed from here too: WebKit sometimes didn't send a second finger's
    // pointerdown while the other was on the joystick.
    on(
      el,
      'touchstart',
      (e) => {
        if (e.cancelable) e.preventDefault();
        this.active = true;
        for (const t of Array.from(e.changedTouches)) {
          const b = this.hit(t.clientX, t.clientY);
          if (b) this.press(b);
        }
      },
      { passive: false },
    );
    const reset = () => this.reset();
    const resize = () => (this.safe = null);
    addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    addEventListener('resize', resize);
    this.offs.push(
      () => removeEventListener('blur', reset),
      () => document.removeEventListener('visibilitychange', reset),
      () => removeEventListener('resize', resize),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
  }

  private radius(): number {
    return 56 * (settings.get().stickScale || 1);
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Is this point (client px) on a HUD button? */
  hitsButton(clientX: number, clientY: number): boolean {
    return this.hit(clientX, clientY) !== null;
  }

  private hit(cx: number, cy: number): Button | null {
    const [x, y] = this.local({ clientX: cx, clientY: cy });
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i]!;
      if (x >= b.x - b.pad && x <= b.x + b.w + b.pad && y >= b.y - b.pad && y <= b.y + b.h + b.pad)
        return b;
    }
    return null;
  }

  /** One touch arrives as touchstart and pointerdown: press once. */
  private press(b: Button): void {
    const k = `${Math.round(b.x)},${Math.round(b.y)}`;
    const now = performance.now();
    if (k === this.lastKey && now - this.lastAt < 350) return;
    this.lastKey = k;
    this.lastAt = now;
    b.fn();
  }

  private down(e: PointerEvent): void {
    const touchy = e.pointerType !== 'mouse';
    if (touchy) this.active = true;
    const b = this.hit(e.clientX, e.clientY);
    if (b) {
      e.preventDefault();
      this.press(b);
      return;
    }
    if (!touchy || !this.canMove()) return;
    const [x, y] = this.local(e);
    const aim = this.twinSticks() && x > this.el.getBoundingClientRect().width / 2;
    if (aim ? this.aimStick : this.stick) return;
    e.preventDefault();
    const s = { id: e.pointerId, ox: x, oy: y, x, y };
    if (aim) this.aimStick = s;
    else this.stick = s;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (already released): the joystick still works while over the game.
    }
  }

  private move(e: PointerEvent): void {
    const s = [this.stick, this.aimStick].find((k) => k?.id === e.pointerId);
    if (!s) return;
    [s.x, s.y] = this.local(e);
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    const r = this.radius();
    if (d > r) {
      s.ox = s.x - (dx / d) * r;
      s.oy = s.y - (dy / d) * r;
    }
  }

  private up(e: PointerEvent): void {
    if (this.stick && e.pointerId === this.stick.id) this.stick = null;
    if (this.aimStick && e.pointerId === this.aimStick.id) this.aimStick = null;
  }

  reset(): void {
    this.stick = null;
    this.aimStick = null;
  }

  /** The joystick's direction (strength 0–1), or null when not in use. */
  vector(): [number, number] | null {
    const s = this.stick;
    if (!s) return null;
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    if (d < 7) return [0, 0];
    // Full speed from half the radius.
    const k = Math.min(1, (d - 7) / (this.radius() * 0.5 - 7));
    return [(dx / d) * k, (dy / d) * k];
  }

  /** The aim stick's direction while it's held off centre, else null (keep the last aim). */
  aimVector(): [number, number] | null {
    const s = this.aimStick;
    if (s && !this.twinSticks()) this.aimStick = null;
    if (!s || !this.twinSticks()) return null;
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    return Math.hypot(dx, dy) < 10 ? null : [dx, dy];
  }

  /** iPhone margins (home bar at the bottom, notch on the sides), in CSS px. */
  safeArea(): { top: number; right: number; bottom: number; left: number } {
    if (this.safe) return this.safe;
    const d = document.createElement('div');
    d.style.cssText =
      'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(d);
    const cs = getComputedStyle(d);
    this.safe = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    d.remove();
    return this.safe;
  }

  /** The HUD clears and registers its buttons every frame (CSS px in the game element). */
  clearButtons(): void {
    this.buttons = [];
  }

  addButton(x: number, y: number, w: number, h: number, fn: () => void, pad = 6): void {
    this.buttons.push({ x, y, w, h, fn, pad });
  }

  /** Draws the joysticks (screen coordinates, CSS px). */
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.stick) this.drawStick(ctx, this.stick, '#ffd23f', '#a55f00');
    if (this.aimStick) this.drawStick(ctx, this.aimStick, '#ff7a59', '#8a2a10');
  }

  private drawStick(ctx: CanvasRenderingContext2D, s: Stick, knob: string, rim: string): void {
    const r = this.radius();
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    const d = Math.hypot(dx, dy);
    const kx = s.ox + (d > r ? (dx / d) * r : dx);
    const ky = s.oy + (d > r ? (dy / d) * r : dy);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = 'rgba(10,20,48,.55)';
    ctx.beginPath();
    ctx.arc(s.ox, s.oy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f4f8ff';
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = knob;
    ctx.beginPath();
    ctx.arc(kx, ky, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = rim;
    ctx.stroke();
    ctx.restore();
  }
}
