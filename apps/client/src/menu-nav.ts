// Gamepad navigation for the DOM menus: the d-pad or the left stick moves a visible focus between
// the controls of the screen on top, A presses the focused one, B goes back.
//   menuNav.push({ root, back?, block? }) → pop      a screen or overlay on top (the game pushes
//                                                  `block` while playing: the pad is its own then)
//   menuNav.press('down' | … | 'confirm' | 'back')  one step (the pad, or tests)
//   menuNav.key(code, target)                       a key: the arrows move, Esc goes back
//   menuNav.moveTo(el)                              the screen moves the focus on itself
//   installMenuNav(base)                            follows the first gamepad and the keys
// Directions repeat while held (`NAV_REPEAT_DELAY_MS`, then every `NAV_REPEAT_MS`). Whatever is
// held when the screen on top changes is ignored until released, so a press or a stick held in
// one screen can't act in the next (nor gameplay movement in a menu).
// On a slider, left / right move it a step; on a switch, left turns it off and right on.
// The keyboard does the same on the screens outside a run (arrows, Esc; Enter and Space press
// the focused button as usual); a run and its overlays handle their own keys.
import { onPadFrame, type PadState } from './input-device.js';

export type NavDir = 'up' | 'down' | 'left' | 'right';
export type NavAction = NavDir | 'confirm' | 'back';

export const NAV_REPEAT_DELAY_MS = 380;
export const NAV_REPEAT_MS = 110;
/** How far the left stick must be pushed to move the focus. */
export const NAV_STICK_DEADZONE = 0.55;

/** Standard-mapping buttons: A, B, and the d-pad. */
const PAD_A = 0;
const PAD_B = 1;
const PAD_DIRS: readonly [number, NavDir][] = [
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
];

/** The menu keys a pad holds: d-pad and left-stick directions, and `a` / `b`. */
export function padNavKeys(p: PadState): Set<string> {
  const keys = new Set<string>();
  for (const [i, dir] of PAD_DIRS) if (p.buttons[i]?.pressed) keys.add(dir);
  const x = p.axes[0] ?? 0;
  const y = p.axes[1] ?? 0;
  // The stick's main direction only, so a diagonal doesn't move twice.
  if (Math.max(Math.abs(x), Math.abs(y)) > NAV_STICK_DEADZONE) {
    if (Math.abs(x) >= Math.abs(y)) keys.add(x < 0 ? 'left' : 'right');
    else keys.add(y < 0 ? 'up' : 'down');
  }
  if (p.buttons[PAD_A]?.pressed) keys.add('a');
  if (p.buttons[PAD_B]?.pressed) keys.add('b');
  return keys;
}

/**
 * Held keys → presses: one when a key goes down, then repeats for the `repeating` ones while
 * held. `latch()` ignores everything held now until it's released.
 */
export class KeyRepeater {
  private readonly down = new Set<string>();
  private readonly latched = new Set<string>();
  private readonly nextAt = new Map<string, number>();

  constructor(private readonly repeating: (key: string) => boolean) {}

  update(held: ReadonlySet<string>, now: number): string[] {
    const out: string[] = [];
    for (const k of [...this.down])
      if (!held.has(k)) {
        this.down.delete(k);
        this.latched.delete(k);
        this.nextAt.delete(k);
      }
    for (const k of held) {
      const fresh = !this.down.has(k);
      this.down.add(k);
      if (this.latched.has(k)) continue;
      if (fresh) {
        out.push(k);
        if (this.repeating(k)) this.nextAt.set(k, now + NAV_REPEAT_DELAY_MS);
      } else {
        const at = this.nextAt.get(k);
        if (at !== undefined && now >= at) {
          out.push(k);
          this.nextAt.set(k, now + NAV_REPEAT_MS);
        }
      }
    }
    return out;
  }

  latch(): void {
    for (const k of this.down) this.latched.add(k);
    this.nextAt.clear();
  }
}

/** The keys that navigate, by `KeyboardEvent.code`. */
const KEY_ACTIONS: Readonly<Record<string, NavAction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Escape: 'back',
  Enter: 'confirm',
};

/**
 * Typing in a field (or moving a slider) keeps the arrows and Esc for itself. A drop-down keeps
 * the arrows (they change its value) but not Esc: while its list is open the browser takes the
 * key to close it, so an Esc that reaches the page means it's closed, and goes back.
 */
function editing(target: EventTarget | null, action: NavAction): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement)
    return target.type !== 'checkbox' && target.type !== 'radio';
  if (target instanceof HTMLSelectElement) return action !== 'back';
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

const isDir = (k: string): k is NavDir =>
  k === 'up' || k === 'down' || k === 'left' || k === 'right';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 1-D gap between two ranges (0 when they overlap). */
const gap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/**
 * The candidate to move to from `from` in `dir` (an index into `rects`), or -1: the nearest one
 * whose centre lies that way, preferring those in the same row (or column).
 */
export function pickNext(from: Rect, rects: readonly Rect[], dir: NavDir): number {
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h / 2;
  let best = -1;
  let bestCost = Infinity;
  rects.forEach((r, i) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const horizontal = dir === 'left' || dir === 'right';
    const primary =
      dir === 'right' ? cx - fx : dir === 'left' ? fx - cx : dir === 'down' ? cy - fy : fy - cy;
    if (primary <= 1) return;
    const off = horizontal
      ? gap(r.y, r.y + r.h, from.y, from.y + from.h)
      : gap(r.x, r.x + r.w, from.x, from.x + from.w);
    const centreOff = horizontal ? Math.abs(cy - fy) : Math.abs(cx - fx);
    const cost = primary + off * 4 + centreOff * 0.1;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  });
  return best;
}

export interface NavScope {
  /** The screen or overlay; its visible, enabled controls are the focus stops. */
  root: HTMLElement;
  /** B. Without it, B presses the scope's visible `[data-back]` button. */
  back?: () => void;
  /** The pad belongs to something else (gameplay): no menu navigation. */
  block?: boolean;
}

const FOCUSABLE =
  'button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The rows along a screen's edge (its title row, the top bar) that only up moves enter. */
const EDGE = '.scr-head, .topbar';
const inEdge = (e: Element | null) => !!e?.closest(EDGE);

/** A screen (`screenBox()`): a lost focus is looked for again only on the same one. */
const SCREEN = '.scr';

/** The class on the control the gamepad focused (styled while the gamepad is active). */
export const NAV_FOCUS_CLASS = 'nav-focus';

function rectOf(e: Element): Rect {
  const r = e.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** A row of tabs or filter chips: left / right go to the previous / next one, in order. */
export const NAV_ROW = 'data-nav-row';
/** A grid of cells (Pokémon): moves go by row and column. */
export const NAV_GRID = 'data-nav-grid';

/**
 * Where `dir` goes from `current` inside its group, measured on `stops` (the visible, enabled
 * controls):
 * - in a row (`data-nav-row`), left / right go to the previous / next control in document order
 *   (so along a wrapped row too) and stop at its ends; up / down are left to geometry;
 * - in a grid (`data-nav-grid`, columns counted from its first row), up / down go one row, to the
 *   same column or the last cell of a shorter row, and left / right stay in the row. From its
 *   edges geometry takes over, leaving the grid.
 * `to`: the control, or null to stay put; undefined: use geometry, without the `exclude` ones
 * and (leaving a grid sideways) only among those `beyond` it.
 */
export function groupMove(
  current: HTMLElement,
  dir: NavDir,
  stops: readonly HTMLElement[],
): { to?: HTMLElement | null; exclude: HTMLElement[]; beyond?: (r: Rect) => boolean } {
  const sideways = dir === 'left' || dir === 'right';
  const step = dir === 'right' || dir === 'down' ? 1 : -1;
  const row = current.parentElement?.closest<HTMLElement>(`[${NAV_ROW}]`);
  if (row) {
    if (!sideways) return { exclude: [] };
    const items = stops.filter((e) => row.contains(e));
    return { to: items[items.indexOf(current) + step] ?? null, exclude: items };
  }
  const grid = current.parentElement?.closest<HTMLElement>(`[${NAV_GRID}]`);
  if (!grid) return { exclude: [] };
  const items = stops.filter((e) => grid.contains(e));
  const i = items.indexOf(current);
  const top = items[0] ? rectOf(items[0]) : null;
  const cols = Math.max(
    1,
    top ? items.filter((e) => Math.abs(rectOf(e).y - top.y) < top.h / 2).length : 1,
  );
  const col = i % cols;
  let to: HTMLElement | undefined;
  if (sideways) {
    const j = col + step;
    if (j >= 0 && j < cols) to = items[i + step];
  } else if (step < 0) {
    to = items[i - cols];
  } else {
    // Down: the cell below, or the last one when the next row is shorter.
    const lastRow = Math.floor((items.length - 1) / cols);
    if (Math.floor(i / cols) < lastRow) to = items[Math.min(i + cols, items.length - 1)];
  }
  // Leaving sideways: only to what lies beyond the grid that way (not the filters above it).
  const box = items.map(rectOf);
  const beyond = sideways
    ? step > 0
      ? (r: Rect) => r.x >= Math.max(...box.map((b) => b.x + b.w))
      : (r: Rect) => r.x + r.w <= Math.min(...box.map((b) => b.x))
    : undefined;
  return { to, exclude: items, beyond };
}

export class MenuNav {
  private readonly stack: NavScope[] = [];
  private readonly keys = new KeyRepeater(isDir);
  private focused: HTMLElement | null = null;

  /** `base`: the scope when nothing is pushed (the app's screens). */
  constructor(private readonly base: () => HTMLElement | null = () => null) {}

  /** Puts a scope on top; returns the function that removes it (wherever it is by then). */
  push(scope: NavScope): () => void {
    this.stack.push(scope);
    this.changed();
    return () => {
      const i = this.stack.indexOf(scope);
      if (i < 0) return;
      this.stack.splice(i, 1);
      this.changed();
    };
  }

  /** The scope on top (null: nothing to navigate). */
  get scope(): NavScope | null {
    const top = this.stack.at(-1);
    if (top) return top;
    const root = this.base();
    return root ? { root } : null;
  }

  /** One gamepad frame. */
  pad(p: PadState | null, now: number): void {
    const pressed = this.keys.update(p ? padNavKeys(p) : new Set(), now);
    if (this.scope?.block) return;
    for (const k of pressed) this.press(k === 'a' ? 'confirm' : k === 'b' ? 'back' : (k as NavDir));
  }

  /**
   * A key press (`KeyboardEvent.code`) on `target`: an arrow or Esc, on the screens outside a
   * run, outside a text field. Returns whether it did something (the caller prevents the default).
   */
  key(code: string, target: EventTarget | null): boolean {
    const action = KEY_ACTIONS[code];
    if (!action || this.stack.length) return false;
    // Esc in a text field leaves it (the next Esc goes back).
    if (
      action === 'back' &&
      (target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement &&
          !['checkbox', 'radio', 'range'].includes(target.type)))
    ) {
      target.blur();
      return true;
    }
    if (editing(target, action)) return false;
    // Enter on a focused control is the browser's (it presses it); with nothing focused it
    // presses the highlighted one.
    if (action === 'confirm' && target instanceof Element && target.matches(FOCUSABLE))
      return false;
    return this.press(action);
  }

  /** One step. Returns whether it did something. */
  press(action: NavAction): boolean {
    const scope = this.scope;
    if (!scope || scope.block) return false;
    if (action === 'back') return this.back(scope);
    const stops = this.stops(scope.root);
    let current = this.current(scope.root, stops);
    if (!current) {
      const first = this.preferred(scope.root, stops);
      if (!first) return false;
      this.focus(first);
      // A highlight already on screen (a cursor list's selection bar, the open tab) is where the
      // focus is: the first press acts from it. Otherwise it shows where the focus is.
      if (!first.matches('[data-nav-default]')) return true;
      current = first;
    }
    if (action === 'confirm') return this.activate(current, scope.root);
    if (this.adjust(current, action, scope.root)) return true;
    // A row of tabs or chips, or a grid, moves in its own order; at its edges geometry takes
    // over, but never back into the same group.
    const grouped = groupMove(current, action, stops);
    if (grouped.to === null) return true;
    if (grouped.to) {
      this.focus(grouped.to);
      return true;
    }
    // The title row's Back and the top bar are reached by going up (or with B), not by a
    // sideways move that happens to point at them.
    const sideways = action === 'left' || action === 'right';
    const others = stops.filter(
      (e) =>
        e !== current &&
        !grouped.exclude.includes(e) &&
        (!grouped.beyond || grouped.beyond(rectOf(e))) &&
        !(sideways && !inEdge(current) && inEdge(e)),
    );
    const i = pickNext(
      rectOf(current),
      others.map((e) => rectOf(e)),
      action,
    );
    const next = others[i];
    if (!next) return false;
    this.focus(next);
    return true;
  }

  /** Moves the focus to `e` (a screen leading on: from a pick to its confirm button). */
  moveTo(e: HTMLElement): void {
    this.focus(e);
  }

  private changed(): void {
    this.keys.latch();
    this.focused?.classList.remove(NAV_FOCUS_CLASS);
    this.focused = null;
  }

  private back(scope: NavScope): boolean {
    if (scope.back) {
      scope.back();
      return true;
    }
    const btn = this.stops(scope.root).find((e) => e.matches('[data-back]'));
    if (!btn) return false;
    btn.click();
    return true;
  }

  /** The visible, enabled focus stops in `root`, in document order. */
  private stops(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => {
      if (e.matches(':disabled') || e.closest('.hidden, [hidden], [inert]')) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
  }

  /** The focused stop, or the one that replaced it (a screen re-rendered under it). */
  private current(root: HTMLElement, stops: HTMLElement[]): HTMLElement | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && stops.includes(active)) {
      if (active !== this.focused) this.mark(active);
      return active;
    }
    const lost = this.focused;
    if (!lost || lost.isConnected || !root.isConnected) return null;
    const id = lost.dataset.testid;
    const same = id ? stops.find((e) => e.dataset.testid === id) : undefined;
    if (!same) return null;
    // Only on the same screen: another one (Back on each) starts from its own highlight.
    const was = lost.closest<HTMLElement>(SCREEN)?.dataset.testid;
    if (was && was !== same.closest<HTMLElement>(SCREEN)?.dataset.testid) return null;
    this.focus(same);
    return same;
  }

  private preferred(root: HTMLElement, stops: HTMLElement[]): HTMLElement | null {
    return (
      stops.find((e) => e.matches('[data-nav-default]')) ??
      stops.find((e) => e.matches('.btn.primary, .btn.gold')) ??
      stops[0] ??
      (root.matches(FOCUSABLE) ? root : null)
    );
  }

  private focus(e: HTMLElement): void {
    e.focus({ preventScroll: true });
    e.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.mark(e);
  }

  private mark(e: HTMLElement): void {
    this.focused?.classList.remove(NAV_FOCUS_CLASS);
    this.focused = e;
    e.classList.add(NAV_FOCUS_CLASS);
  }

  private activate(e: HTMLElement, root: HTMLElement): boolean {
    if (e instanceof HTMLInputElement && e.type === 'range') return false;
    if (e instanceof HTMLInputElement && e.type !== 'checkbox' && e.type !== 'radio') {
      e.focus();
      return true;
    }
    e.click();
    // The click re-rendered the screen: keep the focus on the control that replaced this one.
    if (!e.isConnected) this.current(root, this.stops(root));
    return true;
  }

  /** Left / right on a slider or a switch. */
  private adjust(e: HTMLElement, dir: NavDir, root: HTMLElement): boolean {
    if (dir !== 'left' && dir !== 'right') return false;
    const up = dir === 'right';
    if (e instanceof HTMLInputElement && e.type === 'range') {
      const step = Number(e.step) || 1;
      const min = e.min === '' ? 0 : Number(e.min);
      const max = e.max === '' ? 100 : Number(e.max);
      const value = Math.min(max, Math.max(min, Number(e.value) + (up ? step : -step)));
      // Round off float steps (0.05 + 0.1 is 0.15000000000000002).
      const next = String(Number(value.toFixed((e.step.split('.')[1] ?? '').length)));
      if (next === e.value) return true;
      e.value = next;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const on = e.getAttribute('aria-checked') ?? e.getAttribute('aria-pressed');
    if (e.getAttribute('role') === 'switch' && on !== null) {
      if ((on === 'true') !== up) this.activate(e, root);
      return true;
    }
    return false;
  }
}

export const menuNav = new MenuNav(() => document.querySelector<HTMLElement>('#app'));

let installed = false;

/** Moves the focus with the first gamepad, every frame, and with the keys. Idempotent. */
export function installMenuNav(): void {
  if (installed) return;
  installed = true;
  onPadFrame((pad, now) => menuNav.pad(pad, now));
  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (menuNav.key(e.code, e.target)) e.preventDefault();
  });
}
