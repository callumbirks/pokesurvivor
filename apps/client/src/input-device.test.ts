import { describe, expect, it } from 'vitest';
import {
  InputDeviceTracker,
  MOUSE_SWITCH_BUSY_PX,
  MOUSE_SWITCH_PX,
  PAD_ACTIVITY_DEADZONE,
  PAD_RECENT_MS,
  SWITCH_HOLD_MS,
  padLayout,
  type PadState,
} from './input-device.js';

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DS4_ID = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';

function pad(
  opts: { id?: string; index?: number; pressed?: number[]; axes?: number[] } = {},
): PadState {
  return {
    id: opts.id ?? XBOX_ID,
    index: opts.index ?? 0,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!opts.pressed?.includes(i) })),
    axes: opts.axes ?? [0, 0, 0, 0],
  };
}

/** A tracker on a clock the test moves (`tick(ms)`). */
function tracker() {
  let now = 10_000;
  const d = new InputDeviceTracker('keyboard', () => now);
  return { d, tick: (ms: number) => (now += ms) };
}

describe('the active input device', () => {
  it('ignores a resting stick drifting inside the deadzone', () => {
    const d = new InputDeviceTracker();
    for (const v of [0.05, -0.18, 0.3, PAD_ACTIVITY_DEADZONE])
      d.pad(pad({ axes: [v, -v, v / 2, 0.1] }));
    expect(d.device).toBe('keyboard');
  });

  it('ignores triggers reported as axes resting at -1', () => {
    const d = new InputDeviceTracker();
    d.pad(pad({ axes: [0, 0, 0, 0, -1, -1] }));
    expect(d.device).toBe('keyboard');
  });

  it('switches to the gamepad on a button press or a stick pushed past the deadzone', () => {
    const d = new InputDeviceTracker();
    d.pad(pad({ pressed: [0] }));
    expect(d.device).toBe('gamepad');
    const e = new InputDeviceTracker();
    e.pad(pad({ axes: [0, 0.9, 0, 0] }));
    expect(e.device).toBe('gamepad');
    const f = new InputDeviceTracker();
    f.pad(pad({ axes: [0, 0, -0.8, 0] })); // the right stick
    expect(f.device).toBe('gamepad');
  });

  it('switches back on a key, and a held button or stuck stick does not take it again', () => {
    const { d, tick } = tracker();
    d.pad(pad({ pressed: [0], axes: [0.9, 0, 0, 0] }));
    expect(d.device).toBe('gamepad');
    d.pad(pad({}));
    d.key();
    expect(d.device).toBe('keyboard');
    // A button and a stick held from before the mouse took over don't take it back.
    d.pad(pad({ pressed: [0], axes: [0.9, 0, 0, 0] }));
    expect(d.device).toBe('gamepad');
    tick(PAD_RECENT_MS);
    d.mouseMove(0, 0);
    d.mouseMove(MOUSE_SWITCH_PX, 0);
    expect(d.device).toBe('keyboard');
    for (let i = 0; i < 10; i++) {
      tick(100);
      d.pad(pad({ pressed: [0], axes: [0.9, 0, 0, 0] }));
    }
    expect(d.device).toBe('keyboard');
    // A new press does.
    d.pad(pad({ pressed: [0, 1], axes: [0.9, 0, 0, 0] }));
    expect(d.device).toBe('gamepad');
  });

  it('switches back on a mouse click, or once the mouse really moves', () => {
    const { d, tick } = tracker();
    d.pad(pad({ pressed: [3] }));
    d.pad(pad({}));
    tick(PAD_RECENT_MS);
    d.mouseMove(100, 100);
    d.mouseMove(100 + MOUSE_SWITCH_PX / 2, 100); // a nudge (or a layout shift under the cursor)
    expect(d.device).toBe('gamepad');
    d.mouseMove(100 + MOUSE_SWITCH_PX, 100);
    expect(d.device).toBe('keyboard');
    d.pad(pad({ pressed: [3] }));
    expect(d.device).toBe('gamepad');
    d.pad(pad({}));
    d.pointerDown('mouse');
    expect(d.device).toBe('keyboard');
  });

  it("ignores a remapper's mouse jitter while the pad is in use, unless the mouse really moves", () => {
    const { d, tick } = tracker();
    d.pad(pad({ pressed: [0] }));
    // The stick held while synthetic mouse moves (gyro, Steam Input) wander about.
    let x = 300;
    for (let i = 0; i < 100; i++) {
      tick(16);
      d.pad(pad({ axes: [0.9, 0, 0, 0] }));
      x += i % 2 ? 9 : -6;
      d.mouseMove(x, 200 + (i % 3));
    }
    expect(d.device).toBe('gamepad');
    // A deliberate move does.
    d.mouseMove(x + MOUSE_SWITCH_BUSY_PX, 200);
    expect(d.device).toBe('keyboard');
  });

  it("doesn't take a remapper's key sent with a held button, and records each switch's cause", () => {
    const { d, tick } = tracker();
    d.pad(pad({ pressed: [0] }));
    tick(200);
    d.pad(pad({ pressed: [0] })); // still held
    d.key('KeyW');
    d.pointerDown('mouse');
    expect(d.device).toBe('gamepad');
    d.pad(pad({}));
    d.key('KeyW');
    expect(d.device).toBe('keyboard');
    expect(d.switches.map((s) => `${s.from}>${s.to}: ${s.cause}`)).toEqual([
      `keyboard>gamepad: pad 0 button 0 (${XBOX_ID})`,
      'gamepad>keyboard: key KeyW',
    ]);
  });

  it('a mouse move switches at most once a second', () => {
    const { d, tick } = tracker();
    d.key();
    tick(PAD_RECENT_MS);
    d.pad(pad({ pressed: [0] }));
    d.pad(pad({}));
    tick(PAD_RECENT_MS);
    d.mouseMove(0, 0);
    d.mouseMove(MOUSE_SWITCH_PX, 0);
    expect(d.device).toBe('keyboard');
    d.pad(pad({ pressed: [0] }));
    d.pad(pad({}));
    // Back on the pad at once; a mouse move right after waits for the second to pass.
    expect(d.device).toBe('gamepad');
    tick(PAD_RECENT_MS / 2);
    d.mouseMove(0, 0);
    d.mouseMove(MOUSE_SWITCH_BUSY_PX, 0);
    expect(d.device).toBe('gamepad');
    tick(SWITCH_HOLD_MS);
    d.mouseMove(0, 0);
    d.mouseMove(MOUSE_SWITCH_BUSY_PX, 0);
    expect(d.device).toBe('keyboard');
  });

  it('switches at once on a key pressed after the pad button is let go', () => {
    const { d, tick } = tracker();
    d.pad(pad({ pressed: [1] }));
    tick(80);
    d.pad(pad({}));
    tick(20);
    d.key('Escape');
    expect(d.device).toBe('keyboard');
    // And on a pad press right after a key.
    tick(20);
    d.pad(pad({ pressed: [0] }));
    expect(d.device).toBe('gamepad');
  });

  it('follows the pad used last when several are connected', () => {
    const { d, tick } = tracker();
    d.pad(pad({ index: 0, id: 'Virtual Gamepad' }));
    d.pad(pad({ index: 1, id: DS4_ID, pressed: [0] }));
    expect([d.device, d.layout, d.activePad]).toEqual(['gamepad', 'playstation', 1]);
    tick(100);
    d.pad(pad({ index: 0, id: 'Virtual Gamepad' }));
    expect(d.activePad).toBe(1);
    d.padGone(1);
    expect(d.activePad).toBeNull();
  });

  it('a touch is touch', () => {
    const d = new InputDeviceTracker();
    d.pointerDown('touch');
    expect(d.device).toBe('touch');
  });

  it('detects the PlayStation layout from the pad id, Xbox otherwise', () => {
    expect(padLayout(DS4_ID)).toBe('playstation');
    expect(padLayout('DualSense Wireless Controller')).toBe('playstation');
    expect(padLayout(XBOX_ID)).toBe('xbox');
    expect(padLayout('8BitDo Pro 2 (STANDARD GAMEPAD Vendor: 2dc8)')).toBe('xbox');
    const d = new InputDeviceTracker();
    d.pad({ ...pad({ id: DS4_ID, pressed: [0] }) });
    expect([d.device, d.layout]).toEqual(['gamepad', 'playstation']);
  });

  it('tells subscribers about each change, once', () => {
    const { d, tick } = tracker();
    const seen: string[] = [];
    const off = d.subscribe((device, layout) => seen.push(`${device}/${layout}`));
    d.key(); // already the keyboard
    d.pad(pad({ pressed: [0] }));
    d.pad(pad({ pressed: [0] }));
    d.pad(pad({}));
    d.key();
    off();
    tick(SWITCH_HOLD_MS);
    d.pointerDown('touch');
    expect(seen).toEqual(['gamepad/xbox', 'keyboard/xbox']);
  });
});
