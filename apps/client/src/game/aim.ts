// Manual aim on the client: the auto/manual switch (T, the HUD button), which way the player
// points (the mouse, the right touch joystick, a gamepad's right stick), fire held (the left mouse
// button over the game, a gamepad's right trigger), the indicator around our Pokémon and the
// mouse crosshair. The sim decides what the aim does: this only sends it with each input (`aim`, null
// in auto) and shows it at once (the indicator, and our Pokémon's facing while it attacks).
import { quantizeAim } from '@pokesurvivor/protocol';
import { MANUAL_AIM_CONE } from '@pokesurvivor/sim';
import { settings as appSettings, type SettingsStore } from '../settings.js';

/** The key that switches between auto and manual aim. */
export const AIM_KEY = 'KeyT';

export function toggleAimMode(store: SettingsStore = appSettings): void {
  store.set({ aimMode: store.get().aimMode === 'manual' ? 'auto' : 'manual' });
}

/** A key press during play: T switches the aim mode. True if it was the aim key. */
export function aimKey(code: string, store: SettingsStore = appSettings): boolean {
  if (code !== AIM_KEY) return false;
  toggleAimMode(store);
  return true;
}

/** Which way the player points, in manual mode. */
export class AimTracker {
  /** The aim (radians; screen and world agree on directions). */
  angle = Math.PI / 2;
  /** The mouse over the game (CSS px in the canvas), and whether it aims (it moved last). */
  private mouse: [number, number] | null = null;
  private byMouse = false;
  /** Manual mode has started from the server's aim (so switching doesn't jump). */
  private seeded = false;

  constructor(private readonly store: SettingsStore = appSettings) {}

  get manual(): boolean {
    return this.store.get().aimMode === 'manual';
  }

  /** The mouse over the game (CSS px in the canvas), or null once it left. */
  private over: [number, number] | null = null;

  /** The mouse moved over the game: it aims from now on (until a stick is used). */
  mouseMove(x: number, y: number): void {
    this.mouse = [x, y];
    this.over = [x, y];
    this.byMouse = true;
  }

  /** The mouse left the game: the aim stays where it was. */
  mouseLeave(): void {
    this.over = null;
  }

  /** Where the mouse is over the game, or null (for the crosshair). */
  get pointer(): readonly [number, number] | null {
    return this.over;
  }

  /**
   * Once a frame. `stick`: an aim stick held off centre (touch or gamepad), else null: the aim
   * stays where it was. `self`: our Pokémon on screen (CSS px). `serverAim`: its aim per the
   * server, to start from when manual mode turns on.
   */
  update(stick: [number, number] | null, self: [number, number] | null, serverAim: number | null) {
    if (!this.manual) {
      this.seeded = false;
      return;
    }
    if (!this.seeded) {
      if (serverAim !== null) this.angle = serverAim;
      this.seeded = true;
    }
    if (stick) {
      this.angle = Math.atan2(stick[1], stick[0]);
      this.byMouse = false;
    } else if (this.byMouse && this.mouse && self) {
      const dx = this.mouse[0] - self[0];
      const dy = this.mouse[1] - self[1];
      // Right on top of the Pokémon the direction is noise: keep the last one.
      if (Math.hypot(dx, dy) > 6) this.angle = Math.atan2(dy, dx);
    }
  }

  /** The aim to send (snapped to what the server sees), or null in auto mode. */
  input(): number | null {
    return this.manual ? quantizeAim(this.angle) : null;
  }
}

/**
 * The manual aim around our Pokémon (world coordinates): a faint arc over the cone that chains and
 * meteors pick from, and an arrow where shots go. Centred at shot height (`lift` above the feet).
 */
export function drawAimIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  time: number,
  lift: number,
): void {
  const cy = y - lift;
  const R = 30;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.28;
  ctx.strokeStyle = '#f4f8ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, cy, R, angle - MANUAL_AIM_CONE, angle + MANUAL_AIM_CONE);
  ctx.stroke();
  // The arrow, pulsing outwards a little.
  const d = R + 4 + Math.sin(time * 6) * 1.5;
  const tx = x + Math.cos(angle) * (d + 12);
  const ty = cy + Math.sin(angle) * (d + 12);
  const side = (a: number, r: number): [number, number] => [
    x + Math.cos(angle + a) * r,
    cy + Math.sin(angle + a) * r,
  ];
  const [lx, ly] = side(0.22, d);
  const [rx, ry] = side(-0.22, d);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#ffd23f';
  ctx.strokeStyle = 'rgba(60,30,0,.85)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(lx, ly);
  ctx.lineTo(rx, ry);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

/** Pointer events as far as `MouseFire` reads them (DOM `PointerEvent`s in the game). */
type PointerLike = Event & {
  pointerType?: string;
  button?: number;
  clientX?: number;
  clientY?: number;
};

/**
 * Fire held with the mouse: the left button pressed over the game, unless on a HUD button (the
 * aim switch, move slots, pause), until it's released anywhere or the window loses focus.
 */
export class MouseFire {
  held = false;
  private readonly offs: (() => void)[] = [];

  constructor(
    el: EventTarget,
    win: EventTarget,
    /** Is this point (client px) on a HUD button? */
    onButton: (clientX: number, clientY: number) => boolean,
  ) {
    const on = (target: EventTarget, type: string, fn: (e: PointerLike) => void) => {
      target.addEventListener(type, fn);
      this.offs.push(() => target.removeEventListener(type, fn));
    };
    on(el, 'pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (!onButton(e.clientX ?? 0, e.clientY ?? 0)) this.held = true;
    });
    const release = (e: PointerLike) => {
      if (e.type === 'blur' || e.button === 0 || e.pointerType !== 'mouse') this.held = false;
    };
    on(win, 'pointerup', release);
    on(el, 'pointercancel', release);
    on(win, 'blur', release);
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}

/**
 * The mouse crosshair in manual aim (screen CSS px): pixel-art arms with a dark outline, readable
 * on any ground; gold while firing.
 */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  firing: boolean,
): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  // In 2 px "pixels": arms 1 thick and 3 long, 2 from the centre, and the centre dot.
  const P = 2;
  const rects: [number, number, number, number][] = [
    [-5, -0.5, 3, 1],
    [2, -0.5, 3, 1],
    [-0.5, -5, 1, 3],
    [-0.5, 2, 1, 3],
    [-0.5, -0.5, 1, 1],
  ].map(([rx, ry, rw, rh]) => [cx + rx! * P, cy + ry! * P, rw! * P, rh! * P]);
  ctx.save();
  ctx.fillStyle = 'rgba(10,12,20,.9)';
  for (const [rx, ry, rw, rh] of rects) ctx.fillRect(rx - P, ry - P, rw + 2 * P, rh + 2 * P);
  ctx.fillStyle = firing ? '#ffd23f' : '#f4f8ff';
  for (const [rx, ry, rw, rh] of rects) ctx.fillRect(rx, ry, rw, rh);
  ctx.restore();
}
