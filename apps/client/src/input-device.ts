// The input device the player is using now: keyboard and mouse, a gamepad, or touch. Prompts
// follow it (controller glyphs while a gamepad is in use, keys otherwise), the way PC games do.
//   inputDevice.device / .layout       'keyboard' | 'gamepad' | 'touch', 'xbox' | 'playstation'
//   inputDevice.subscribe(fn)          called on every change; returns the unsubscribe
//   inputDevice.switches               the last switches and what caused them (?debug-input)
//   installInputDevice()               listens to the window and polls the gamepads (once)
//   onPadFrame(fn)                     the pad in use, every animation frame
// A gamepad counts once a button is pressed or a stick is pushed past `PAD_ACTIVITY_DEADZONE`
// (a resting stick's drift doesn't); a key, a mouse click or real mouse movement switch back.
// Remappers (Steam Input, DS4Windows, gyro-to-mouse) send mouse movement and keys alongside the
// pad, so while the pad was used in the last `PAD_RECENT_MS` the mouse must travel
// `MOUSE_SWITCH_BUSY_PX` to count, a mouse move switches at most once per `SWITCH_HOLD_MS`, and a
// key or click while a pad button is held doesn't switch. With several pads (a real one and a
// virtual one), the one used last is the one in use.
// `<html data-input="…" data-pad="…">` mirrors the state for the stylesheet (glyphs, the hidden
// cursor, the gamepad focus ring).

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';
export type PadLayout = 'xbox' | 'playstation';

/** How far a stick must be pushed to count as using the gamepad. */
export const PAD_ACTIVITY_DEADZONE = 0.5;
/** How far the mouse must travel (CSS px) to switch back from the gamepad. */
export const MOUSE_SWITCH_PX = 24;
/** The same, while the pad was used just now (a remapper's mouse jitter doesn't count). */
export const MOUSE_SWITCH_BUSY_PX = 160;
/** How long after the last pad input the pad counts as being used (ms). */
export const PAD_RECENT_MS = 1500;
/** The least time between two device switches (ms). */
export const SWITCH_HOLD_MS = 1000;
/** How many switches `switches` keeps. */
const SWITCH_LOG = 20;

/** What the tracker reads of a `Gamepad`. */
export interface PadState {
  readonly id: string;
  readonly index: number;
  readonly buttons: readonly { readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

/** A device switch and what caused it. */
export interface DeviceSwitch {
  at: number;
  from: InputDevice;
  to: InputDevice;
  cause: string;
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
  /** When a pad was last used (anything held or pushed), and when the device last switched. */
  private padAt = -Infinity;
  private switchedAt = -Infinity;
  /** Whether a pad button or stick is held at the last poll. */
  private padHeld = false;
  /** The pad used last (its index). */
  activePad: number | null = null;
  /** The last switches, newest last. */
  readonly switches: DeviceSwitch[] = [];

  constructor(
    initial: InputDevice = 'keyboard',
    private readonly clock: () => number = () => performance.now(),
  ) {
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
  key(code = ''): void {
    this.set('keyboard', this.padLayout, `key ${code}`.trim(), true);
  }

  /** A pointer press: a mouse (or pen) click is the keyboard and mouse; a touch is touch. */
  pointerDown(pointerType: string): void {
    this.set(
      pointerType === 'touch' ? 'touch' : 'keyboard',
      this.padLayout,
      `${pointerType} press`,
      true,
    );
  }

  /**
   * The mouse moved to (x, y). While the gamepad is active it only switches back once the mouse
   * has travelled `MOUSE_SWITCH_PX` (a layout change under a still cursor fires moves too), or
   * `MOUSE_SWITCH_BUSY_PX` while the pad is being used.
   */
  mouseMove(x: number, y: number): void {
    if (this.current !== 'gamepad') return;
    if (!this.mouseAnchor) {
      this.mouseAnchor = { x, y };
      return;
    }
    const busy = this.clock() - this.padAt < PAD_RECENT_MS;
    const d = Math.hypot(x - this.mouseAnchor.x, y - this.mouseAnchor.y);
    if (d >= (busy ? MOUSE_SWITCH_BUSY_PX : MOUSE_SWITCH_PX))
      this.set('keyboard', this.padLayout, `mouse moved ${Math.round(d)}px`);
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
    this.padHeld = buttons.some(Boolean) || axes.some(Boolean);
    if (this.padHeld) this.padAt = this.clock();
    const button = buttons.findIndex((b, i) => b && !prev?.buttons[i]);
    const axis = axes.findIndex((a, i) => a && !prev?.axes[i]);
    if (button < 0 && axis < 0) return;
    this.activePad = p.index;
    this.set(
      'gamepad',
      padLayout(p.id),
      `pad ${p.index} ${button >= 0 ? `button ${button}` : `axis ${axis}`} (${p.id})`,
      true,
    );
  }

  /** A pad was disconnected: forget what it held. */
  padGone(index: number): void {
    this.held.delete(index);
    if (this.activePad === index) this.activePad = null;
  }

  /**
   * Switches to `device`. A mouse move switches at most once a second after the last switch, so
   * a remapper's mouse jitter can't make it flicker. A `deliberate` input (a key, a click, a pad
   * press) switches right away, except a key or click while a pad button or stick is held: that
   * is a remapper's key, sent with the button.
   */
  private set(device: InputDevice, layout: PadLayout, cause: string, deliberate = false): void {
    if (device === this.current && layout === this.padLayout) return;
    const now = this.clock();
    const hold = deliberate
      ? device !== 'gamepad' && this.padHeld
      : now - this.switchedAt < SWITCH_HOLD_MS;
    if (device !== this.current && hold) return;
    if (device !== this.current) {
      this.switches.push({ at: now, from: this.current, to: device, cause });
      if (this.switches.length > SWITCH_LOG) this.switches.shift();
      this.switchedAt = now;
    }
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

/** The pad in use: the one used last, else the first connected one, or null. */
export function firstPad(): Gamepad | null {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  let first: Gamepad | null = null;
  for (const p of pads) {
    if (!p?.connected) continue;
    if (p.index === inputDevice.activePad) return p;
    first ??= p;
  }
  return first;
}

const padFrame = new Set<(pad: Gamepad | null, now: number) => void>();

/** Called every animation frame with the pad in use (after the tracker saw it). */
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
  addEventListener('keydown', (e) => inputDevice.key(e.code), opts);
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
  if (new URLSearchParams(location.search).has('debug-input')) showInputLog();
}

/**
 * `?debug-input`: a corner panel with the pads connected and the last device switches with what
 * caused each (and the console logs them), for a player whose prompts keep switching.
 */
function showInputLog(): void {
  const panel = document.createElement('pre');
  panel.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:100;max-width:60vw;margin:0;padding:6px 8px;' +
    'font:11px/1.3 ui-monospace,monospace;color:#f2e9d8;background:rgba(20,16,18,.85);' +
    'pointer-events:none;white-space:pre-wrap';
  document.body.append(panel);
  let shown = 0;
  const render = () => {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const list = [...pads].filter((p) => p?.connected).map((p) => `  ${p?.index}: ${p?.id}`);
    for (const s of inputDevice.switches.slice(shown))
      console.info(`[input] ${s.from} → ${s.to}: ${s.cause}`);
    shown = inputDevice.switches.length;
    panel.textContent = [
      `input: ${inputDevice.device} (${inputDevice.layout}), pad in use: ${inputDevice.activePad ?? '-'}`,
      'pads:',
      ...list,
      'switches:',
      ...inputDevice.switches
        .slice(-8)
        .map((s) => `  ${(s.at / 1000).toFixed(1)}s ${s.from} → ${s.to}: ${s.cause}`),
    ].join('\n');
  };
  render();
  setInterval(render, 500);
}
