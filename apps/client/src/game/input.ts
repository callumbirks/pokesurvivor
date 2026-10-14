// Keyboard and gamepad (legacy core/input.js; touch is touch.ts). Movement is sampled every tick;
// key presses (move slots, cycling, pause, choices) are delivered as they happen.
//   WASD / arrows   move              1–4      move slot (or pick an option)
//   Q / E / Tab     previous / next   R        reroll cards     Esc / P  pause
//   T               auto / manual aim (manual: the mouse aims; see aim.ts)
// Gamepad: left stick or d-pad to move, right stick to aim (manual), LB / RB to cycle moves,
// A/B/X/Y = options 1–4, R3 (right stick press) auto / manual aim, Start pause.

const MOVE_KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};
const NO_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);
/** Gamepad buttons (standard mapping) → the key they act as. */
const PAD_KEYS: Record<number, string> = {
  0: 'Digit1',
  1: 'Digit2',
  2: 'Digit3',
  3: 'Digit4',
  4: 'KeyQ',
  5: 'KeyE',
  8: 'KeyR',
  9: 'Escape',
  11: 'KeyT',
};
const DEAD_ZONE = 0.22;
/** The right stick only aims once clearly pushed (it rests a little off centre). */
const AIM_DEAD_ZONE = 0.35;

export class Input {
  private down = new Set<string>();
  private padDown = new Set<number>();
  private readonly offs: (() => void)[] = [];

  /** `onKey`: a key press (`KeyboardEvent.code`); return true to prevent its default. */
  constructor(private readonly onKey: (code: string) => boolean) {
    const kd = (e: KeyboardEvent) => {
      // Typing in a field (a chat, a dev panel) isn't playing.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!e.repeat && this.onKey(e.code)) e.preventDefault();
      this.down.add(e.code);
      if (NO_SCROLL.has(e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => this.down.delete(e.code);
    const blur = () => this.down.clear();
    addEventListener('keydown', kd);
    addEventListener('keyup', ku);
    addEventListener('blur', blur);
    this.offs.push(
      () => removeEventListener('keydown', kd),
      () => removeEventListener('keyup', ku),
      () => removeEventListener('blur', blur),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
  }

  private pad(): Gamepad | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) if (p?.connected) return p;
    return null;
  }

  /** Polls gamepad buttons (call every frame): presses become keys. */
  poll(): void {
    const p = this.pad();
    if (!p) return;
    p.buttons.forEach((b, i) => {
      const code = PAD_KEYS[i];
      if (!code) return;
      if (b.pressed && !this.padDown.has(i)) {
        this.padDown.add(i);
        this.onKey(code);
      } else if (!b.pressed) this.padDown.delete(i);
    });
  }

  /** The gamepad's right stick, when pushed (for manual aim); null at rest or with no pad. */
  aimAxis(): [number, number] | null {
    const p = this.pad();
    if (!p) return null;
    const x = p.axes[2] ?? 0;
    const y = p.axes[3] ?? 0;
    return Math.hypot(x, y) > AIM_DEAD_ZONE ? [x, y] : null;
  }

  /** The movement vector (length ≤ 1): the joystick if given, else the gamepad, else keys. */
  axis(touch: [number, number] | null): [number, number] {
    if (touch && (touch[0] || touch[1])) return touch;
    const p = this.pad();
    if (p) {
      let x = p.axes[0] ?? 0;
      let y = p.axes[1] ?? 0;
      if (p.buttons[14]?.pressed) x = -1;
      if (p.buttons[15]?.pressed) x = 1;
      if (p.buttons[12]?.pressed) y = -1;
      if (p.buttons[13]?.pressed) y = 1;
      const d = Math.hypot(x, y);
      if (d > DEAD_ZONE) return d > 1 ? [x / d, y / d] : [x, y];
    }
    const has = (keys: string[]) => keys.some((k) => this.down.has(k));
    const x = (has(MOVE_KEYS.right) ? 1 : 0) - (has(MOVE_KEYS.left) ? 1 : 0);
    const y = (has(MOVE_KEYS.down) ? 1 : 0) - (has(MOVE_KEYS.up) ? 1 : 0);
    const d = Math.hypot(x, y);
    return d > 0 ? [x / d, y / d] : [0, 0];
  }
}
