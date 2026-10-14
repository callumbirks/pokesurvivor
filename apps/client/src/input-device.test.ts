import { describe, expect, it } from 'vitest';
import {
  InputDeviceTracker,
  MOUSE_SWITCH_PX,
  PAD_ACTIVITY_DEADZONE,
  padLayout,
  type PadState,
} from './input-device.js';

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const DS4_ID = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';

function pad(opts: { id?: string; pressed?: number[]; axes?: number[] } = {}): PadState {
  return {
    id: opts.id ?? XBOX_ID,
    index: 0,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!opts.pressed?.includes(i) })),
    axes: opts.axes ?? [0, 0, 0, 0],
  };
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
    const d = new InputDeviceTracker();
    d.pad(pad({ pressed: [0], axes: [0.9, 0, 0, 0] }));
    expect(d.device).toBe('gamepad');
    d.key();
    expect(d.device).toBe('keyboard');
    for (let i = 0; i < 10; i++) d.pad(pad({ pressed: [0], axes: [0.9, 0, 0, 0] }));
    expect(d.device).toBe('keyboard');
    // A new press does.
    d.pad(pad({ pressed: [0, 1], axes: [0.9, 0, 0, 0] }));
    expect(d.device).toBe('gamepad');
  });

  it('switches back on a mouse click, or once the mouse really moves', () => {
    const d = new InputDeviceTracker();
    d.pad(pad({ pressed: [3] }));
    d.mouseMove(100, 100);
    d.mouseMove(100 + MOUSE_SWITCH_PX / 2, 100); // a nudge (or a layout shift under the cursor)
    expect(d.device).toBe('gamepad');
    d.mouseMove(100 + MOUSE_SWITCH_PX, 100);
    expect(d.device).toBe('keyboard');
    d.pad(pad({}));
    d.pad(pad({ pressed: [3] }));
    expect(d.device).toBe('gamepad');
    d.pointerDown('mouse');
    expect(d.device).toBe('keyboard');
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
    const d = new InputDeviceTracker();
    const seen: string[] = [];
    const off = d.subscribe((device, layout) => seen.push(`${device}/${layout}`));
    d.key(); // already the keyboard
    d.pad(pad({ pressed: [0] }));
    d.pad(pad({ pressed: [0] }));
    d.key();
    off();
    d.pointerDown('touch');
    expect(seen).toEqual(['gamepad/xbox', 'keyboard/xbox']);
  });
});
