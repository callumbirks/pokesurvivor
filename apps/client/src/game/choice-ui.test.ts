// @vitest-environment happy-dom
import { loadGameData, t, type UiStringKey } from '@pokesurvivor/data';
import type { ChoiceRef } from '@pokesurvivor/netclient';
import type { PendingChoice } from '@pokesurvivor/sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHOICE_INPUT_GRACE_MS, ChoiceOverlay } from './choice-ui.js';
import { ChoiceState, type ChoiceSnapshot } from './choices.js';
import { Input } from './input.js';
import { statCardDescription } from './text.js';
import { NAV_REPEAT_DELAY_MS } from '../menu-nav.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', () => ({
  iconImg: () => document.createElement('img'),
  typeColor: () => '#ffffff',
}));

const levelUp = (cards: string[], deadlineTick: number | null = 900): PendingChoice => ({
  id: 1,
  playerId: 'me',
  kind: 'level-up',
  level: 3,
  deadlineTick,
  options: cards.map((c) => ({
    id: c,
    type: c.split(':')[0] as 'new',
    moveId: c.split(':')[1],
  })),
});
const theirs: ChoiceRef = { id: 2, playerId: 'p2', kind: 'level-up', deadlineTick: 900 };

function setup() {
  let now = 0;
  const send = vi.fn(() => Promise.resolve({ ok: true as const }));
  const parent = document.createElement('div');
  const state = new ChoiceState('me', 30, (id) => (id === 'p2' ? 'Misty' : id), send);
  const overlay = new ChoiceOverlay(parent, state, () => now);
  const show = (s: ChoiceSnapshot) => {
    state.sync(s);
    overlay.update();
  };
  const cards = () => [...parent.querySelectorAll('.ps-card')];
  return {
    parent,
    state,
    overlay,
    show,
    cards,
    send,
    advance(ms: number) {
      now += ms;
    },
  };
}

const snap = (
  choices: PendingChoice[],
  tick: number,
  waiting: ChoiceRef[] = [],
  rerollsLeft = 1,
): ChoiceSnapshot => ({
  tick,
  choices,
  waiting: [
    ...choices.map((c) => ({
      id: c.id,
      playerId: c.playerId,
      kind: c.kind,
      deadlineTick: c.deadlineTick,
    })),
    ...waiting,
  ],
  rerollsLeft,
});

describe('the choice overlay DOM', () => {
  it('keeps the same box and cards across repeated snapshots of the same choice', () => {
    const h = setup();
    const cards = ['new:ember', 'upgrade:tackle', 'stat:speed'];
    // Every snapshot is a fresh object, as decoded from the network or the solo worker.
    h.show(snap([levelUp(cards)], 0, [theirs]));
    const box = h.parent.querySelector('.ps-box');
    const before = h.cards();
    expect(before).toHaveLength(3);
    expect(h.parent.querySelector('[data-testid=deadline]')?.textContent).toBe('30 s');
    // Three seconds of co-op snapshots at 20 Hz (the countdown ticks, the teammate is still
    // choosing), then of solo frames at 30 Hz (no deadline).
    for (let tick = 1; tick <= 90; tick += 1.5)
      h.show(snap([levelUp(cards)], Math.round(tick), [theirs]));
    expect(h.parent.querySelector('.ps-box')).toBe(box);
    expect(h.cards()).toEqual(before);
    h.cards().forEach((c, i) => expect(c).toBe(before[i]));
    // The live parts did change.
    expect(h.parent.querySelector('[data-testid=deadline]')?.textContent).toBe('27 s');
    expect(h.parent.textContent).toContain('Misty');
    h.show(snap([levelUp(cards)], 91, []));
    expect(h.parent.textContent).not.toContain('Misty');
    expect(h.cards()).toEqual(before);

    const solo = setup();
    solo.show(snap([levelUp(cards, null)], 0));
    const soloCards = solo.cards();
    for (let tick = 1; tick <= 90; tick++) solo.show(snap([levelUp(cards, null)], tick));
    solo.cards().forEach((c, i) => expect(c).toBe(soloCards[i]));
    expect(solo.parent.querySelector('[data-testid=deadline]')?.classList.contains('hidden')).toBe(
      true,
    );
  });

  it('rebuilds the cards after a reroll (same box), and makes a new box for the next choice', () => {
    const h = setup();
    h.show(snap([levelUp(['new:ember', 'upgrade:tackle', 'stat:speed'])], 0));
    const box = h.parent.querySelector('.ps-box');
    const before = h.cards();
    h.show(snap([levelUp(['new:gust', 'stat:attack', 'stat:regen'])], 40, [], 0));
    expect(h.parent.querySelector('.ps-box')).toBe(box);
    expect(h.cards()[0]).not.toBe(before[0]);
    expect(h.parent.querySelector('[data-testid=reroll]')).toBeNull();
    h.show(snap([], 41));
    expect(h.parent.querySelector('.ps-box')).toBeNull();
    h.show(snap([{ ...levelUp(['new:bite']), id: 5 }], 60));
    expect(h.parent.querySelector('.ps-box')).not.toBe(box);
  });

  it('labels the reroll button "Reroll" with the count and the R key', () => {
    const h = setup();
    h.show(snap([levelUp(['new:ember', 'upgrade:tackle', 'stat:speed'])], 0, [], 2));
    expect(h.parent.querySelector('[data-testid=reroll]')?.textContent).toBe('Reroll (2) · R');
  });
});

const reward = () => levelUp(['new:ember', 'upgrade:tackle', 'stat:speed', 'stat:attack']);
const inputs: Input[] = [];
afterEach(() => {
  for (const input of inputs.splice(0)) input.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bindInput(h: ReturnType<typeof setup>): Input {
  const input = new Input((code) => h.overlay.key(code));
  inputs.push(input);
  return input;
}

function key(type: 'keydown' | 'keyup', code: string, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, cancelable: true }));
}

function pointer(button: Element, type: 'pointerdown' | 'click', pointerType = 'mouse'): void {
  button.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, pointerType }),
  );
}

describe('the choice input grace window', () => {
  it.each(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Numpad1', 'Numpad4', 'KeyR'])(
    'drops %s inside the window and accepts it at 200 ms',
    (code) => {
      const h = setup();
      h.show(snap([reward()], 0));
      h.advance(CHOICE_INPUT_GRACE_MS - 1);
      expect(h.overlay.key(code)).toBe(true); // consumed, so it cannot reach gameplay
      expect(h.send).not.toHaveBeenCalled();
      h.advance(1);
      h.overlay.update();
      expect(h.send).not.toHaveBeenCalled(); // the dropped press is never queued
      expect(h.overlay.key(code)).toBe(true);
      expect(h.send).toHaveBeenCalledOnce();
    },
  );

  it.each(['mouse', 'touch'])(
    'requires a fresh %s press after the window, for both cards and reroll',
    (pointerType) => {
      for (const selector of ['[data-testid=option-0]', '[data-testid=reroll]']) {
        const h = setup();
        h.show(snap([reward()], 0));
        const button = h.parent.querySelector(selector)!;
        pointer(button, 'pointerdown', pointerType);
        pointer(button, 'click', pointerType);
        expect(h.send).not.toHaveBeenCalled();
        h.advance(CHOICE_INPUT_GRACE_MS - 1);
        pointer(button, 'pointerdown', pointerType);
        h.advance(1);
        pointer(button, 'click', pointerType); // down before the window ended, up afterwards
        expect(h.send).not.toHaveBeenCalled();
        pointer(button, 'click', pointerType); // no down on the menu (e.g. held gameplay fire)
        expect(h.send).not.toHaveBeenCalled();
        pointer(button, 'pointerdown', pointerType);
        pointer(button, 'click', pointerType);
        expect(h.send).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])('requires release of a number key held %s before opening', (before) => {
    const h = setup();
    bindInput(h);
    if (before) key('keydown', 'Digit1');
    h.show(snap([reward()], 0));
    if (!before) key('keydown', 'Digit1');
    h.advance(CHOICE_INPUT_GRACE_MS);
    key('keydown', 'Digit1', true);
    h.overlay.update();
    expect(h.send).not.toHaveBeenCalled();
    key('keyup', 'Digit1');
    key('keydown', 'Digit1');
    expect(h.send).toHaveBeenCalledOnce();
  });

  it.each([0, 8])('drops gamepad button %s until released and pressed again', (button) => {
    const h = setup();
    const input = bindInput(h);
    const buttons = Array.from({ length: 12 }, () => ({ pressed: false }));
    const pad = { connected: true, buttons, axes: [] };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    h.show(snap([reward()], 0));
    buttons[button]!.pressed = true;
    input.poll();
    h.advance(CHOICE_INPUT_GRACE_MS);
    input.poll();
    expect(h.send).not.toHaveBeenCalled();
    buttons[button]!.pressed = false;
    input.poll();
    buttons[button]!.pressed = true;
    input.poll();
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('does not turn a gamepad button held before opening into a choice', () => {
    const h = setup();
    const input = bindInput(h);
    const buttons = [{ pressed: true }];
    const pad = { connected: true, buttons, axes: [] };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    input.poll();
    h.show(snap([reward()], 0));
    h.advance(CHOICE_INPUT_GRACE_MS);
    input.poll();
    expect(h.send).not.toHaveBeenCalled();
    buttons[0]!.pressed = false;
    input.poll();
    buttons[0]!.pressed = true;
    input.poll();
    expect(h.send).toHaveBeenCalledOnce();
  });

  it.each(['Enter', 'Space'])(
    'suppresses native %s activation during the window and held repeats afterwards',
    (code) => {
      const h = setup();
      h.show(snap([reward()], 0));
      const button = h.cards()[0]!;
      const down = (repeat = false) =>
        button.dispatchEvent(
          new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true }),
        );
      expect(down()).toBe(false); // prevent default, including Space's deferred keyup click
      expect(h.send).not.toHaveBeenCalled();
      h.advance(CHOICE_INPUT_GRACE_MS);
      down(true);
      expect(h.send).not.toHaveBeenCalled();
      down();
      expect(h.send).toHaveBeenCalledOnce();
    },
  );

  it('starts on visibility, and repeated snapshots/live updates do not restart it', () => {
    const h = setup();
    h.state.sync(snap([reward()], 0));
    h.advance(1000); // a snapshot received before rendering is not visible yet
    h.overlay.update();
    expect(h.overlay.key('Digit1')).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    h.advance(CHOICE_INPUT_GRACE_MS - 1);
    h.show(snap([reward()], 40, [theirs])); // re-render with a new countdown and waiting line
    h.advance(1);
    h.show(snap([reward()], 41, []));
    h.overlay.key('Digit1');
    expect(h.send).toHaveBeenCalledOnce();
  });

  it.each(['reroll', 'queued', 'reopened', 'identical reroll'])(
    'restarts for a %s menu and invalidates an earlier pointer press',
    (kind) => {
      const h = setup();
      h.show(snap([reward()], 0));
      h.advance(CHOICE_INPUT_GRACE_MS);
      pointer(h.cards()[0]!, 'pointerdown');
      if (kind === 'reopened') h.show(snap([], 1));
      const next =
        kind === 'reroll'
          ? levelUp(['new:gust', 'stat:attack', 'stat:regen'])
          : kind === 'queued'
            ? { ...reward(), id: 2 }
            : reward();
      h.show(snap([next], 2, [], kind === 'identical reroll' ? 0 : 1));
      h.overlay.key('Digit1');
      expect(h.send).not.toHaveBeenCalled();
      h.advance(CHOICE_INPUT_GRACE_MS - 1);
      h.overlay.key('Digit1');
      expect(h.send).not.toHaveBeenCalled();
      h.advance(1);
      pointer(h.cards()[0]!, 'click');
      expect(h.send).not.toHaveBeenCalled();
      h.overlay.key('Digit1');
      expect(h.send).toHaveBeenCalledOnce();
    },
  );

  it('gates bond back buttons and keys when the second step becomes visible', () => {
    const h = setup();
    h.show(
      snap(
        [
          {
            id: 9,
            playerId: 'me',
            kind: 'bond',
            mode: 'pair',
            group: null,
            loose: ['gust', 'bite'],
            deadlineTick: null,
          },
        ],
        0,
      ),
    );
    h.advance(CHOICE_INPUT_GRACE_MS);
    h.overlay.key('Digit1');
    h.overlay.update();
    const back = h.parent.querySelector('.row button')!;
    pointer(back, 'pointerdown');
    pointer(back, 'click');
    h.overlay.key('Backspace');
    h.overlay.key('Escape');
    expect(h.state.view()!.first).toBe('gust');
    h.advance(CHOICE_INPUT_GRACE_MS);
    pointer(back, 'pointerdown');
    pointer(back, 'click');
    expect(h.state.view()!.first).toBeNull();
  });
});

describe('the gamepad in a choice', () => {
  const glyphs = (h: ReturnType<typeof setup>) =>
    h.cards().map((c) => c.querySelector<HTMLElement>('.pad-only .glyph')?.dataset.glyph ?? null);
  const focused = (h: ReturnType<typeof setup>) =>
    h.cards().findIndex((c) => c.classList.contains('focus'));

  it('moves the highlight with the d-pad (wrapping); only it shows a glyph (A)', () => {
    const h = setup();
    h.show(snap([reward()], 0));
    expect(focused(h)).toBe(0);
    expect(glyphs(h)).toEqual(['a', null, null, null]);
    expect(h.overlay.key('PadDown')).toBe(true);
    expect(h.overlay.key('PadRight')).toBe(true);
    expect(focused(h)).toBe(2);
    expect(glyphs(h)).toEqual([null, null, 'a', null]);
    h.overlay.key('PadUp');
    h.overlay.key('PadUp');
    h.overlay.key('PadLeft');
    expect(focused(h)).toBe(3);
    // Keys show the numbers.
    expect(h.cards().map((c) => c.querySelector('.kb-only')?.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('A picks the highlighted option, only after the grace window', () => {
    const h = setup();
    h.show(snap([reward()], 0));
    h.overlay.key('PadDown');
    expect(h.overlay.key('PadA')).toBe(true); // consumed: it can't reach gameplay
    h.advance(CHOICE_INPUT_GRACE_MS - 1);
    h.overlay.key('PadA');
    expect(h.send).not.toHaveBeenCalled();
    h.advance(1);
    h.overlay.key('PadA');
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'upgrade:tackle' }));
  });

  it('B, X and Y never pick (and are consumed, so they cannot switch move slots)', () => {
    const h = setup();
    const input = bindInput(h);
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
    const pad = { connected: true, buttons, axes: [0, 0, 0, 0] };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    h.show(snap([reward()], 0));
    h.advance(CHOICE_INPUT_GRACE_MS);
    for (const b of [1, 2, 3]) {
      buttons[b]!.pressed = true;
      input.poll();
      buttons[b]!.pressed = false;
      input.poll();
    }
    for (const code of ['PadB', 'PadX', 'PadY']) expect(h.overlay.key(code)).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.state.view()).not.toBeNull();
  });

  it('starts each new menu (a reroll) on the first option', () => {
    const h = setup();
    h.show(snap([reward()], 0));
    h.overlay.key('PadDown');
    h.show(snap([levelUp(['new:gust', 'stat:attack', 'stat:regen'])], 10, [], 0));
    expect(focused(h)).toBe(0);
  });

  it('leaves the face buttons and the d-pad to the game outside a choice', () => {
    const h = setup();
    for (const code of ['PadA', 'PadB', 'PadX', 'PadY']) expect(h.overlay.key(code)).toBe(false);
    expect(h.overlay.key('PadDown')).toBe(false);
  });

  it('ignores a d-pad held from gameplay until released, then repeats it while held', () => {
    const h = setup();
    const seen: string[] = [];
    const input = new Input((code) => (seen.push(code), h.overlay.key(code)));
    inputs.push(input);
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
    const pad = { connected: true, buttons, axes: [0, 0, 0, 0] };
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    buttons[13]!.pressed = true; // walking down
    input.poll(0);
    h.show(snap([reward()], 0));
    input.latchNav(); // the game does this when a choice opens
    input.poll(16);
    input.poll(2000);
    expect(seen).toEqual(['PadDown']); // the one from gameplay, before the choice
    buttons[13]!.pressed = false;
    input.poll(2016);
    buttons[13]!.pressed = true;
    input.poll(2032);
    input.poll(2032 + NAV_REPEAT_DELAY_MS);
    expect(seen.slice(1)).toEqual(['PadDown', 'PadDown']);
  });
});

describe('stat card rarities', () => {
  const d = loadGameData();
  const { tiers } = d.levelUp.rarity;
  const top = tiers.at(-1)!;
  const rarityUp = (): PendingChoice => ({
    id: 5,
    playerId: 'me',
    kind: 'level-up',
    level: 4,
    deadlineTick: null,
    options: [
      { id: 'stat:attack', type: 'stat', statId: 'attack', rarity: top.id },
      { id: 'stat:heal', type: 'stat', statId: 'heal' },
      { id: 'new:ember', type: 'new', moveId: 'ember' },
    ],
  });

  it('shows the rarity name, its gacha colour as the frame, and the rolled amount', () => {
    const h = setup();
    h.show(snap([rarityUp()], 0));
    const [power, berry] = h.cards() as HTMLElement[];
    const color = d.gacha.rarities.find((r) => r.rarity === top.gachaRarity)!.color;
    expect(power!.classList.contains('rarity')).toBe(true);
    expect(power!.style.getPropertyValue('--rc')).toBe(color);
    expect(power!.querySelector('.nm')!.textContent).toContain(
      t(`levelUp.rarity.${top.id}` as UiStringKey),
    );
    expect(power!.querySelector('.ds')!.textContent).toBe(
      statCardDescription(d.statCardById.get('attack')!, top.multiplier),
    );
    // No placeholder left behind, and no rarity on a card without one.
    expect(power!.querySelector('.ds')!.textContent).not.toMatch(/[{}]/);
    expect(berry!.classList.contains('rarity')).toBe(false);
    expect(berry!.querySelector('.nm')!.textContent).toContain(t('levelUp.upgrade'));
  });

  it('still picks with the keys and the pad', () => {
    const h = setup();
    h.show(snap([rarityUp()], 0));
    h.advance(CHOICE_INPUT_GRACE_MS);
    h.overlay.key('Digit1');
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ cardId: 'stat:attack' }));
    const g = setup();
    g.show(snap([rarityUp()], 0));
    g.advance(CHOICE_INPUT_GRACE_MS);
    g.overlay.key('PadDown');
    g.overlay.key('PadA');
    expect(g.send).toHaveBeenLastCalledWith(expect.objectContaining({ cardId: 'stat:heal' }));
  });
});
