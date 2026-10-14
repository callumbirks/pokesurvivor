// The input device the player is using now: keyboard and mouse, a gamepad, or touch. Prompts
// follow it (controller glyphs while a gamepad is in use, keys otherwise), the way PC games do.
//   inputDevice.device / .layout       'keyboard' | 'gamepad' | 'touch', 'xbox' | 'playstation'
//   inputDevice.subscribe(fn)          called on every change; returns the unsubscribe
//   installInputDevice()               listens to the window and polls the gamepads (once)
//   onPadFrame(fn)                     the first connected pad, every animation frame
// A gamepad counts once a button is pressed or a stick is pushed past `PAD_ACTIVITY_DEADZONE`
// (a resting stick's drift doesn't); a key, a mouse click or real mouse movement switch back.
// `<html data-input="…" data-pad="…">` mirrors the state for the stylesheet (glyphs, the hidden
// cursor, the gamepad focus ring).

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';
export type PadLayout = 'xbox' | 'playstation';

/** How far a stick must be pushed to count as using the gamepad. */
export const PAD_ACTIVITY_DEADZONE = 0.5;
/** How far the mouse must travel (CSS px) to switch back from the gamepad. */
export const MOUSE_SWITCH_PX = 24;

/** What the tracker reads of a `Gamepad`. */
export interface PadState {
  readonly id: string;
  readonly index: number;
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

/** The face-button layout from `Gamepad.id`: PlayStation pads by name or Sony's USB vendor id. */
export function padLayout(id: string): PadLayout {
  return /playstation|dualshock|dualsense|054c|sony|ps[345]\b/i.test(id) ? 'playstation' : 'xbox';
}

type Listener = (device: InputDevice, layout: PadLayout) => void;

export class InputDeviceTracker {
  private current: InputDevice;
  private padLayout: PadLayout = 'xbox';
  private readonly listeners = new Set<Listener>();
  /** Per pad: the buttons held and the stick axes pushed at the last poll (to see new ones). */
  private readonly held = new Map<number, { buttons: boolean[]; axes: boolean[] }>();
  /** Where the mouse was when the gamepad took over. */
  private mouseAnchor: { x: number; y: number } | null = null;

  constructor(initial: InputDevice = 'keyboard') {
    this.current = initial;
  }

  get device(): InputDevice {
    return this.current;
  }

  get layout(): PadLayout {
    return this.padLayout;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A key press. */
  key(): void {
    this.set('keyboard');
  }

  /** A pointer press: a mouse (or pen) click is the keyboard and mouse; a touch is touch. */
  pointerDown(pointerType: string): void {
    this.set(pointerType === 'touch' ? 'touch' : 'keyboard');
  }

  /**
   * The mouse moved to (x, y). While the gamepad is active it only switches back once the mouse
   * has travelled `MOUSE_SWITCH_PX` (a layout change under a still cursor fires moves too).
   */
  mouseMove(x: number, y: number): void {
    if (this.current !== 'gamepad') return;
    if (!this.mouseAnchor) {
      this.mouseAnchor = { x, y };
      return;
    }
    if (Math.hypot(x - this.mouseAnchor.x, y - this.mouseAnchor.y) >= MOUSE_SWITCH_PX)
      this.set('keyboard');
  }

  /**
   * A gamepad poll. Only new activity switches to it: a button pressed since the last poll, or a
   * stick pushed past the deadzone. A held button or a stuck stick can't take it back from the
   * keyboard again and again.
   */
  pad(p: PadState): void {
    const prev = this.held.get(p.index);
    const buttons = p.buttons.map((b) => b.pressed);
    // Only the sticks (axes 0–3): some pads report triggers as axes resting at -1.
    const axes = p.axes.slice(0, 4).map((v) => Math.abs(v) > PAD_ACTIVITY_DEADZONE);
    this.held.set(p.index, { buttons, axes });
    const fresh =
      buttons.some((b, i) => b && !prev?.buttons[i]) || axes.some((a, i) => a && !prev?.axes[i]);
    if (!fresh) return;
    this.set('gamepad', padLayout(p.id));
  }

  /** A pad was disconnected: forget what it held. */
  padGone(index: number): void {
    this.held.delete(index);
  }

  private set(device: InputDevice, layout = this.padLayout): void {
    if (device === this.current && layout === this.padLayout) return;
    this.current = device;
    this.padLayout = layout;
    this.mouseAnchor = null;
    for (const fn of [...this.listeners]) fn(device, layout);
  }
}

export const inputDevice = new InputDeviceTracker(
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    ? 'touch'
    : 'keyboard',
);

/** The first connected gamepad, or null. */
export function firstPad(): Gamepad | null {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const p of pads) if (p?.connected) return p;
  return null;
}

const padFrame = new Set<(pad: Gamepad | null, now: number) => void>();

/** Called every animation frame with the first connected pad (after the tracker saw it). */
export function onPadFrame(fn: (pad: Gamepad | null, now: number) => void): () => void {
  padFrame.add(fn);
  return () => padFrame.delete(fn);
}

let installed = false;

/** Listens for keys, the mouse and touches, and polls the gamepads every frame. Idempotent. */
export function installInputDevice(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const root = document.documentElement;
  const show = () => {
    root.dataset.input = inputDevice.device;
    root.dataset.pad = inputDevice.layout;
  };
  show();
  inputDevice.subscribe(show);
  const opts = { capture: true, passive: true };
  addEventListener('keydown', () => inputDevice.key(), opts);
  addEventListener('pointerdown', (e) => inputDevice.pointerDown(e.pointerType), opts);
  addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'mouse') inputDevice.mouseMove(e.clientX, e.clientY);
    },
    opts,
  );
  addEventListener('gamepaddisconnected', (e) => inputDevice.padGone(e.gamepad.index));
  const poll = (now: number) => {
    requestAnimationFrame(poll);
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) if (p?.connected) inputDevice.pad(p);
    if (!padFrame.size) return;
    const pad = firstPad();
    for (const fn of [...padFrame]) fn(pad, now);
  };
  requestAnimationFrame(poll);
}
