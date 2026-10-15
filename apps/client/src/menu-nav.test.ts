// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { PadState } from './input-device.js';
import {
  KeyRepeater,
  MenuNav,
  NAV_FOCUS_CLASS,
  NAV_REPEAT_DELAY_MS,
  NAV_REPEAT_MS,
  padNavKeys,
  pickNext,
  type Rect,
} from './menu-nav.js';

/** happy-dom doesn't lay out: give elements their boxes. */
function place<T extends HTMLElement>(e: T, x: number, y: number, w = 80, h = 30): T {
  e.getBoundingClientRect = () =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y }) as DOMRect;
  return e;
}

function button(id: string, x: number, y: number, parent: HTMLElement): HTMLButtonElement {
  const b = place(document.createElement('button'), x, y);
  b.dataset.testid = id;
  b.textContent = id;
  parent.append(b);
  return b;
}

function screen(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.testid;

function pad(opts: { pressed?: number[]; axes?: number[] } = {}): PadState {
  return {
    id: 'test pad',
    index: 0,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!opts.pressed?.includes(i) })),
    axes: opts.axes ?? [0, 0, 0, 0],
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('pickNext', () => {
  const r = (x: number, y: number, w = 80, h = 30): Rect => ({ x, y, w, h });

  it('moves to the nearest control in that direction, preferring the same row or column', () => {
    // A 2 × 2 grid with a wide button below.
    const from = r(0, 0);
    const cands = [r(100, 0), r(0, 50), r(100, 50), r(0, 100, 180)];
    expect(pickNext(from, cands, 'right')).toBe(0);
    expect(pickNext(from, cands, 'down')).toBe(1);
    expect(pickNext(r(100, 50), cands.slice(0, 2).concat(r(0, 100, 180)), 'down')).toBe(2);
    expect(pickNext(from, cands, 'left')).toBe(-1);
    expect(pickNext(from, cands, 'up')).toBe(-1);
    // A close control in another row loses to a farther one in the same row.
    expect(pickNext(from, [r(90, 60), r(200, 0)], 'right')).toBe(1);
  });
});

describe('the pad as menu keys', () => {
  it('reads the d-pad, the left stick past its deadzone (its main direction), A and B', () => {
    expect([...padNavKeys(pad({ pressed: [12, 0] }))].sort()).toEqual(['a', 'up']);
    expect([...padNavKeys(pad({ axes: [0.3, -0.2, 0, 0] }))]).toEqual([]); // drift
    expect([...padNavKeys(pad({ axes: [0.9, 0.7, 0, 0] }))]).toEqual(['right']);
    expect([...padNavKeys(pad({ axes: [-0.2, 0.8, 0, 0], pressed: [1] }))].sort()).toEqual([
      'b',
      'down',
    ]);
    // The right stick doesn't navigate.
    expect([...padNavKeys(pad({ axes: [0, 0, 1, 1] }))]).toEqual([]);
  });

  it('repeats a held direction after a delay, and ignores latched keys until released', () => {
    const k = new KeyRepeater((key) => key !== 'a');
    const held = (...keys: string[]) => new Set(keys);
    expect(k.update(held('down', 'a'), 0)).toEqual(['down', 'a']);
    expect(k.update(held('down', 'a'), NAV_REPEAT_DELAY_MS - 1)).toEqual([]);
    expect(k.update(held('down', 'a'), NAV_REPEAT_DELAY_MS)).toEqual(['down']);
    expect(k.update(held('down', 'a'), NAV_REPEAT_DELAY_MS + NAV_REPEAT_MS)).toEqual(['down']);
    k.latch();
    expect(k.update(held('down', 'a'), 5000)).toEqual([]);
    expect(k.update(held('down'), 5001)).toEqual([]); // still latched
    expect(k.update(held(), 5002)).toEqual([]);
    expect(k.update(held('down', 'a'), 5003)).toEqual(['down', 'a']);
  });
});

describe('MenuNav', () => {
  function menu() {
    const root = screen();
    const play = button('play', 0, 0, root);
    const shop = button('shop', 0, 40, root);
    const off = button('off', 0, 80, root);
    off.disabled = true;
    const hidden = document.createElement('div');
    hidden.className = 'hidden';
    root.append(hidden);
    button('hidden', 0, 120, hidden);
    const settings = button('settings', 0, 160, root);
    const back = button('back', 100, 0, root);
    back.dataset.back = '';
    const nav = new MenuNav(() => root);
    return { root, play, shop, settings, back, nav };
  }

  it('moves with the arrow keys and goes back with Esc, but not in a field or with a scope on top', () => {
    const { root, nav, back } = menu();
    let backs = 0;
    back.addEventListener('click', () => backs++);
    expect(nav.key('ArrowDown', document.body)).toBe(true);
    expect(focusedId()).toBe('play');
    expect(nav.key('ArrowDown', document.activeElement)).toBe(true);
    expect(focusedId()).toBe('shop');
    expect(nav.key('KeyA', document.activeElement)).toBe(false);
    expect(nav.key('Escape', document.activeElement)).toBe(true);
    expect(backs).toBe(1);
    // Typing: the field keeps the arrows; Esc leaves it (and doesn't go back).
    const field = document.createElement('input');
    root.append(field);
    field.focus();
    expect(nav.key('ArrowDown', field)).toBe(false);
    expect(nav.key('Escape', field)).toBe(true);
    expect(document.activeElement).not.toBe(field);
    expect(backs).toBe(1);
    // A drop-down keeps the arrows (they change its value), but Esc goes back.
    const select = document.createElement('select');
    root.append(select);
    select.focus();
    expect(nav.key('ArrowDown', select)).toBe(false);
    expect(nav.key('Escape', select)).toBe(true);
    expect(backs).toBe(2);
    // A run or an overlay on top handles its own keys.
    const pop = nav.push({ root: screen() });
    expect(nav.key('ArrowDown', document.body)).toBe(false);
    pop();
    expect(nav.key('ArrowDown', document.body)).toBe(true);
  });

  it('shows the focus on the first press, then moves it, skipping disabled and hidden controls', () => {
    const { nav, play } = menu();
    expect(nav.press('down')).toBe(true);
    expect(focusedId()).toBe('play');
    expect(play.classList.contains(NAV_FOCUS_CLASS)).toBe(true);
    nav.press('down');
    expect(focusedId()).toBe('shop');
    expect(play.classList.contains(NAV_FOCUS_CLASS)).toBe(false);
    nav.press('down');
    expect(focusedId()).toBe('settings');
    expect(nav.press('down')).toBe(false); // the end: it stays
    expect(focusedId()).toBe('settings');
    nav.press('up');
    nav.press('up');
    nav.press('right');
    expect(focusedId()).toBe('back');
  });

  it('acts from a highlight already on screen: the first press moves on from it, or presses it', () => {
    // A cursor list's selection bar (or the open tab) is shown before any input.
    const { nav, shop } = menu();
    shop.dataset.navDefault = '';
    nav.press('down');
    expect(focusedId()).toBe('settings');
    const m = menu();
    const clicks: string[] = [];
    m.shop.addEventListener('click', () => clicks.push('shop'));
    m.shop.dataset.navDefault = '';
    m.nav.press('confirm');
    expect(clicks).toEqual(['shop']);
  });

  it('enters the title row and the top bar only going up, not sideways', () => {
    const root = screen();
    const head = document.createElement('header');
    head.className = 'scr-head';
    root.append(head);
    const back = button('back', 100, 0, head);
    // A list down the left, the pulls far below to the right.
    const kanto = button('kanto', 0, 60, root);
    button('johto', 0, 100, root);
    button('pull', 300, 400, root);
    const nav = new MenuNav(() => root);
    kanto.focus();
    nav.press('right');
    expect(focusedId()).toBe('pull');
    kanto.focus();
    nav.press('up');
    expect(focusedId()).toBe('back');
    // From the title row itself, sideways moves stay in it or leave it as usual.
    back.focus();
    nav.press('down');
    expect(focusedId()).toBe('kanto');
  });

  it('A presses the focused control and B the back button (or the scope’s back)', () => {
    const { nav, root, shop, back } = menu();
    const clicks: string[] = [];
    root.addEventListener('click', (e) => clicks.push((e.target as HTMLElement).dataset.testid!));
    nav.press('confirm'); // nothing focused yet: focus first
    expect(clicks).toEqual([]);
    shop.focus();
    nav.press('confirm');
    nav.press('back');
    expect(clicks).toEqual(['shop', 'back']);
    back.remove();
    expect(nav.press('back')).toBe(false);
    let backs = 0;
    const pop = nav.push({ root, back: () => backs++ });
    nav.press('back');
    expect(backs).toBe(1);
    pop();
  });

  it('moves sliders and switches with left / right', () => {
    const root = screen();
    const range = place(document.createElement('input'), 0, 0);
    range.type = 'range';
    range.min = '0';
    range.max = '1';
    range.step = '0.05';
    range.value = '0.5';
    const sw = place(document.createElement('button'), 0, 40);
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.addEventListener('click', () =>
      sw.setAttribute(
        'aria-checked',
        sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true',
      ),
    );
    root.append(range, sw);
    const values: string[] = [];
    range.addEventListener('input', () => values.push(range.value));
    const nav = new MenuNav(() => root);
    range.focus();
    nav.press('right');
    nav.press('left');
    nav.press('left');
    expect(values).toEqual(['0.55', '0.5', '0.45']);
    expect(nav.press('confirm')).toBe(false); // A does nothing on a slider
    range.value = '1';
    nav.press('right');
    expect(values).toHaveLength(3); // at the end
    nav.press('down');
    expect(document.activeElement).toBe(sw);
    nav.press('right');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    nav.press('right'); // already on
    expect(sw.getAttribute('aria-checked')).toBe('true');
    nav.press('left');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the focus on the same control when a press re-renders the screen', () => {
    const root = screen();
    const render = (on: boolean) => {
      root.replaceChildren();
      const t = button('toggle', 0, 0, root);
      t.addEventListener('click', () => render(!on));
      button('next', 0, 40, root);
    };
    render(false);
    const nav = new MenuNav(() => root);
    nav.press('down');
    expect(focusedId()).toBe('toggle');
    nav.press('confirm');
    expect(focusedId()).toBe('toggle');
    expect(document.activeElement?.isConnected).toBe(true);
    nav.press('down');
    expect(focusedId()).toBe('next');
  });

  it('starts a new screen from its highlight, not from a control with the same id', () => {
    const root = screen();
    const show = (id: string) => {
      const scr = document.createElement('section');
      scr.className = 'scr';
      scr.dataset.testid = id;
      root.replaceChildren(scr);
      return scr;
    };
    const nav = new MenuNav(() => root);
    button('back', 0, 0, show('screen-gacha'));
    nav.press('down');
    expect(focusedId()).toBe('back');
    const solo = show('screen-solo');
    button('back', 0, 0, solo);
    button('pick', 0, 40, solo).dataset.navDefault = '';
    button('play', 0, 80, solo);
    nav.press('down');
    expect(focusedId()).toBe('play');
  });

  it('moveTo moves the focus and its mark, and the next press goes on from there', () => {
    const { nav, play, shop } = menu();
    nav.press('down');
    expect(play.classList.contains(NAV_FOCUS_CLASS)).toBe(true);
    nav.moveTo(shop);
    expect(focusedId()).toBe('shop');
    expect(play.classList.contains(NAV_FOCUS_CLASS)).toBe(false);
    expect(shop.classList.contains(NAV_FOCUS_CLASS)).toBe(true);
    nav.press('down');
    expect(focusedId()).toBe('settings');
  });

  describe('rows and grids', () => {
    /**
     * Region tabs (one row), filter chips of uneven widths wrapping onto a second line, a grid of
     * 7 cells in 3 columns (the last row short), and a button right of the grid.
     */
    function collection() {
      const root = screen();
      const group = (attr: 'navRow' | 'navGrid') => {
        const g = document.createElement('div');
        g.dataset[attr] = '';
        root.append(g);
        return g;
      };
      const tabs = group('navRow');
      for (let i = 0; i < 3; i++) button(`tab-${i}`, i * 90, 0, tabs);
      const chips = group('navRow');
      place(button('chip-0', 0, 40, chips), 0, 40, 60, 24);
      place(button('chip-1', 0, 40, chips), 70, 40, 200, 24);
      place(button('chip-2', 0, 72, chips), 0, 72, 40, 24);
      const grid = group('navGrid');
      for (let i = 0; i < 7; i++)
        place(button(`cell-${i}`, 0, 0, grid), (i % 3) * 90, 110 + Math.floor(i / 3) * 90, 80, 80);
      button('choose', 300, 120, root);
      const nav = new MenuNav(() => root);
      const from = (id: string) =>
        root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.focus();
      return { nav, from };
    }

    it('moves along a row in order, onto its wrapped line, and stops at its ends', () => {
      const { nav, from } = collection();
      from('chip-0');
      nav.press('right');
      expect(focusedId()).toBe('chip-1');
      nav.press('right');
      expect(focusedId()).toBe('chip-2');
      expect(nav.press('right')).toBe(true);
      expect(focusedId()).toBe('chip-2');
      nav.press('left');
      nav.press('left');
      expect(focusedId()).toBe('chip-0');
      nav.press('left');
      expect(focusedId()).toBe('chip-0');
      // The last tab doesn't jump to another row.
      from('tab-2');
      nav.press('right');
      expect(focusedId()).toBe('tab-2');
      // Up and down leave the row by geometry.
      from('chip-0');
      nav.press('up');
      expect(focusedId()).toBe('tab-0');
    });

    it('moves up and down a grid by one row, to the same column or the end of a short row', () => {
      const { nav, from } = collection();
      from('cell-4');
      nav.press('up');
      expect(focusedId()).toBe('cell-1');
      nav.press('down');
      nav.press('down');
      // The last row has one cell: the nearest one.
      expect(focusedId()).toBe('cell-6');
      from('cell-5');
      nav.press('down');
      expect(focusedId()).toBe('cell-6');
      // Only the top row goes up to the filters.
      from('cell-1');
      nav.press('up');
      expect(focusedId()).toMatch(/^chip-/);
    });

    it('moves sideways within a grid row, and leaves the grid only from its edges', () => {
      const { nav, from } = collection();
      from('cell-3');
      nav.press('right');
      expect(focusedId()).toBe('cell-4');
      nav.press('left');
      nav.press('left');
      // Nothing to the left of the grid: it stays, rather than wrapping to the row above.
      expect(focusedId()).toBe('cell-3');
      from('cell-2');
      nav.press('right');
      expect(focusedId()).toBe('choose');
      from('cell-6');
      expect(nav.press('down')).toBe(false);
    });

    /**
     * The Pokémon picker: filter chips wider than the grid above it, a scrolled grid of 3 columns
     * (its box shows rows 1–2 of 0–3), and beside it the details with a Normal / Shiny switch on
     * top and the confirm button at the bottom.
     */
    function picker() {
      const root = screen();
      const chips = document.createElement('div');
      chips.dataset.navRow = '';
      root.append(chips);
      place(button('chip-0', 0, 0, chips), 0, 0, 200, 24);
      place(button('chip-1', 0, 0, chips), 300, 0, 200, 24);
      const grid = place(document.createElement('div'), 0, 40, 280, 180);
      grid.dataset.navGrid = '';
      grid.dataset.navRight = '[data-testid="confirm"]';
      root.append(grid);
      for (let i = 0; i < 12; i++) {
        const c = place(
          button(`cell-${i}`, 0, 0, grid),
          (i % 3) * 90,
          -50 + Math.floor(i / 3) * 90,
          80,
          80,
        );
        c.className = i === 4 ? 'cell on' : 'cell';
      }
      button('normal', 300, 60, root);
      const confirm = place(button('confirm', 0, 0, root), 300, 180, 200, 40);
      confirm.dataset.navLeft = '.cell.on';
      const nav = new MenuNav(() => root);
      const from = (id: string) =>
        root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.focus();
      return { nav, from, confirm };
    }

    it('follows a link from a grid’s edge or a control, before geometry', () => {
      const { nav, from, confirm } = picker();
      // → from the grid's right edge: the confirm button, from any row (not the Normal switch).
      from('cell-5');
      nav.press('right');
      expect(focusedId()).toBe('confirm');
      // ← from it: the selected cell, not the one nearest.
      nav.press('left');
      expect(focusedId()).toBe('cell-4');
      // Inside the grid the link waits for its edge.
      nav.press('right');
      expect(focusedId()).toBe('cell-5');
      // A link to nothing that can take the focus: geometry.
      confirm.disabled = true;
      from('cell-5');
      nav.press('right');
      expect(focusedId()).toBe('normal');
    });

    it('leaves a grid sideways only to what lies beside it, and never into cells out of view', () => {
      const { nav, from, confirm } = picker();
      delete confirm.dataset.navLeft;
      confirm.disabled = true;
      // The chips reach past the grid's right edge but lie above it.
      from('cell-2');
      nav.press('right');
      expect(focusedId()).toBe('normal');
      confirm.disabled = false;
      // Down from the confirm button: the cells scrolled out under the grid's box aren't below.
      from('confirm');
      expect(nav.press('down')).toBe(false);
      // Left: the nearest cell in view (rows 1–2), not one scrolled out.
      nav.press('left');
      expect(focusedId()).toBe('cell-8');
    });
  });

  it('does nothing under a blocking scope (gameplay), and the top scope wins', () => {
    const { nav, root } = menu();
    const game = screen();
    const resume = button('resume', 0, 0, game);
    const popBlock = nav.push({ root: game, block: true });
    expect(nav.press('down')).toBe(false);
    expect(nav.press('back')).toBe(false);
    const pause = screen();
    button('continue', 0, 0, pause);
    const popPause = nav.push({ root: pause });
    nav.press('down');
    expect(focusedId()).toBe('continue');
    popPause();
    expect(nav.press('down')).toBe(false);
    popBlock();
    nav.press('down');
    expect(root.contains(document.activeElement)).toBe(true);
    expect(resume.classList.contains(NAV_FOCUS_CLASS)).toBe(false);
  });

  it('a direction or A held when the scope changes waits for release (no leaks)', () => {
    const { nav, root } = menu();
    const clicks: string[] = [];
    root.addEventListener('click', (e) => clicks.push((e.target as HTMLElement).dataset.testid!));
    const game = screen();
    const pop = nav.push({ root: game, block: true });
    // Moving down and pressing A in the game…
    nav.pad(pad({ pressed: [13, 0] }), 0);
    // …then the game ends with both held: nothing happens in the menu until they're let go.
    pop();
    nav.pad(pad({ pressed: [13, 0] }), 16);
    nav.pad(pad({ pressed: [13, 0] }), 2000);
    expect(document.activeElement).toBe(document.body);
    expect(clicks).toEqual([]);
    nav.pad(pad(), 2016);
    nav.pad(pad({ pressed: [13] }), 2032);
    expect(focusedId()).toBe('play');
    nav.pad(pad({ pressed: [13] }), 2032 + NAV_REPEAT_DELAY_MS);
    expect(focusedId()).toBe('shop');
    nav.pad(pad({ axes: [0, 0.2, 0, 0] }), 3000); // stick drift: nothing
    nav.pad(pad({ pressed: [0] }), 3016);
    expect(clicks).toEqual(['shop']);
  });
});
