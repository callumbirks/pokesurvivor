// @vitest-environment happy-dom
import { loadGameData, prestigeBonus, type Move } from '@pokesurvivor/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../app/app.js';
import type { Save } from '../app/api.js';
import { MenuNav } from '../menu-nav.js';
import { shopScreen } from './shop.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', () => ({
  iconImg: (id: string) => Object.assign(document.createElement('img'), { alt: id }),
  iconUrl: () => '',
  typeColor: () => '#ffffff',
}));
vi.mock('../audio.js', () => ({ audio: { sfx: () => {} } }));

const data = loadGameData();
const maxed = Object.fromEntries(data.upgrades.map((u) => [u.id, u.maxLevel]));
const rules = Object.fromEntries(
  data.upgrades.map((u) => [
    u.id,
    { maxLevel: u.maxLevel, baseCost: u.baseCost, growth: u.costGrowth },
  ]),
);

const { prestigeCost, resetCost } = data.tuning.gems;
let version = 0;

function save(
  upgrades: Record<string, number>,
  prestige?: number,
  moves: { bans?: string[]; repertoire?: string } = {},
  gems = prestigeCost,
): Save {
  return {
    coins: 0,
    gems,
    updatedAt: String(version++),
    partner: { dex: 4, shiny: false },
    owned: { 4: { at: 0, from: 'starter' } },
    shiny: {},
    upgrades: { 4: upgrades },
    prestige: prestige ? { 4: prestige } : {},
    moveBans: { 4: moves.bans ?? [] },
    moveBindings: {},
    repertoireMoves: moves.repertoire ? { 4: moves.repertoire } : {},
  } as unknown as Save;
}

function fakeApp(s: Save, refund: number) {
  let onSave = () => {};
  const app = {
    save: s,
    api: {
      request: vi.fn(() => Promise.resolve({ upgrades: rules })),
      prestige: vi.fn(() => Promise.resolve(save({}, (s.prestige?.['4'] ?? 0) + 1))),
      resetQuote: vi.fn((dex: number) => Promise.resolve({ dex, refund, cost: resetCost })),
      resetUpgrades: vi.fn(() =>
        Promise.resolve(save({}, s.prestige?.['4'], {}, (s.gems ?? 0) - resetCost)),
      ),
      setMoves: vi.fn((_dex: number, body: { repertoire?: string | null }) =>
        Promise.resolve(
          save(app.save.upgrades['4'] ?? {}, undefined, {
            bans: app.save.moveBans['4'],
            ...(body.repertoire ? { repertoire: body.repertoire } : {}),
          }),
        ),
      ),
    },
    events: { on: (_: string, fn: () => void) => ((onSave = fn), () => {}) },
    act: async (_: unknown, fn: () => Promise<unknown>) => fn(),
    setSave: vi.fn((next: Save) => {
      app.save = next;
      onSave();
    }),
    go: vi.fn(),
  };
  return app;
}

async function mount(s: Save, refund = 0) {
  const app = fakeApp(s, refund);
  const screen = shopScreen(app as unknown as App);
  document.body.append(screen.el);
  await vi.waitFor(() => expect(screen.el.querySelector('[data-testid="prestige"]')).toBeTruthy());
  const button = () =>
    screen.el.querySelector<HTMLButtonElement>('[data-testid="prestige-button"]');
  return { app, screen, button };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('upgrades screen: prestige', () => {
  it('enables the Prestige button only when every upgrade is maxed', async () => {
    const short = { ...maxed, attack: (maxed.attack ?? 1) - 1 };
    expect((await mount(save(short))).button()?.disabled).toBe(true);
    document.body.replaceChildren();
    expect((await mount(save(maxed))).button()?.disabled).toBe(false);
  });

  it(`needs ${prestigeCost} gems, shown on the button and the status`, async () => {
    const { button, screen } = await mount(save(maxed, undefined, {}, prestigeCost - 1));
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toContain(String(prestigeCost));
    expect(screen.el.querySelector('[data-testid="prestige-status"]')?.textContent).toBe(
      `Every upgrade is maxed: prestiging costs ${prestigeCost} gems, you have ${prestigeCost - 1}.`,
    );
  });

  it('has no button at the highest prestige, and shows the stars', async () => {
    const top = data.tuning.prestige.maxStars;
    const { screen, button } = await mount(save(maxed, top));
    expect(button()).toBeNull();
    const stars = screen.el.querySelector<HTMLElement>('.prestige-head [data-testid="stars"]');
    expect(stars?.textContent).toBe('★'.repeat(top));
  });

  it('asks first, saying what resets and what it gains, then prestiges on confirm', async () => {
    const { app, button } = await mount(save(maxed, 1));
    button()!.click();
    const dialog = await vi.waitFor(() => {
      const d = document.querySelector<HTMLElement>('[data-testid="prestige-dialog"]');
      expect(d).toBeTruthy();
      return d!;
    });
    expect(dialog.textContent).toContain(String(data.upgrades.length));
    const gains = [...dialog.querySelectorAll('[data-testid="prestige-gains"] .chip')].map(
      (c) => c.textContent,
    );
    const b = prestigeBonus(data.tuning.prestige, 2);
    expect(gains).toContain(`+${Math.round((b.hpMul - 1) * 100)}% HP`);
    expect(gains).toHaveLength(6);
    expect(dialog.querySelector('[data-testid="prestige-cost"]')?.textContent).toContain(
      `Costs ${prestigeCost} gems (you have ${prestigeCost})`,
    );

    // Cancel does nothing.
    dialog.querySelector<HTMLButtonElement>('[data-testid="dialog-cancel"]')!.click();
    expect(document.querySelector('[data-testid="prestige-dialog"]')).toBeNull();
    expect(app.api.prestige).not.toHaveBeenCalled();

    button()!.click();
    document.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]')!.click();
    await vi.waitFor(() => expect(app.api.prestige).toHaveBeenCalledWith(4));
    expect(app.setSave).toHaveBeenCalled();
  });

  it('cancels with Escape', async () => {
    const { app, button } = await mount(save(maxed));
    button()!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="prestige-dialog"]')).toBeTruthy(),
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('[data-testid="prestige-dialog"]')).toBeNull();
    expect(app.api.prestige).not.toHaveBeenCalled();
  });

  it('shows the prestige share on the stat bars and chips for the flat stats', async () => {
    const { screen } = await mount(save({}, 2));
    const stats = screen.el.querySelector<HTMLElement>('.prestige-stats')!;
    expect(stats.querySelectorAll('.bar b')).toHaveLength(3);
    const mon = data.pokemonByDex.get(4)!;
    const b = prestigeBonus(data.tuning.prestige, 2);
    expect(stats.textContent).toContain(String(Math.round(mon.hp * b.hpMul)));
    expect(stats.querySelectorAll('[data-testid="prestige-box"] .chip')).toHaveLength(3);
  });
});

describe('upgrades screen: reset', () => {
  const reset = () => document.querySelector<HTMLButtonElement>('[data-testid="reset-button"]');
  /** The Reset button once the screen has the server's quote. */
  const quoted = () =>
    vi.waitFor(() => {
      expect(reset()?.dataset.refund).not.toBe('');
      return reset()!;
    });

  it('is disabled with nothing bought since the last prestige, or short of gems', async () => {
    await mount(save({ attack: 2 }, undefined, {}, resetCost), 0);
    expect((await quoted()).disabled).toBe(true);
    expect(reset()!.title).toBe('Nothing bought since its last prestige: nothing to reset.');
    document.body.replaceChildren();

    await mount(save({ attack: 2 }, undefined, {}, resetCost - 1), 250);
    expect((await quoted()).disabled).toBe(true);
    expect(reset()!.title).toBe(`Resetting costs ${resetCost} gems, you have ${resetCost - 1}.`);
    document.body.replaceChildren();

    const { app } = await mount(save({ attack: 2 }, undefined, {}, resetCost), 250);
    expect((await quoted()).disabled).toBe(false);
    expect(reset()!.textContent).toContain(String(resetCost));
    expect(app.api.resetQuote).toHaveBeenCalledWith(4);
  });

  it('warns what resets, the exact refund, the cost and that stars stay, then resets', async () => {
    const moves = { bans: ['scratch'], repertoire: 'tackle' };
    const s = save({ ban: 1, 'extra-move': 1 }, 2, moves, 140);
    const { app } = await mount(s, 1234);
    (await quoted()).click();
    const dialog = await vi.waitFor(() => {
      const d = document.querySelector<HTMLElement>('[data-testid="reset-dialog"]');
      expect(d).toBeTruthy();
      return d!;
    });
    const text = dialog.textContent ?? '';
    expect(text).toContain("can't be undone");
    expect(text).toContain('Repertoire and Ban included');
    expect(text).toContain('banned moves are cleared');
    expect(text).toContain('second move goes back to random');
    expect(dialog.querySelector('[data-testid="reset-refund"]')?.textContent).toContain(
      '+1,234 PokéCoins',
    );
    expect(dialog.querySelector('[data-testid="reset-cost"]')?.textContent).toContain(
      `Costs ${resetCost} gems (you have 140)`,
    );
    expect(dialog.querySelector('[data-testid="reset-keeps"]')?.textContent).toContain(
      'prestige stars stay (2)',
    );
    expect(dialog.querySelector('[data-testid="dialog-confirm"]')?.textContent).toBe(
      `Reset for ${resetCost} gems`,
    );

    dialog.querySelector<HTMLButtonElement>('[data-testid="dialog-cancel"]')!.click();
    expect(app.api.resetUpgrades).not.toHaveBeenCalled();

    reset()!.click();
    document.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]')!.click();
    await vi.waitFor(() => expect(app.api.resetUpgrades).toHaveBeenCalledWith(4));
    expect(app.save.gems).toBe(140 - resetCost);
  });
});

describe('upgrades screen: Repertoire', () => {
  const charmander = data.pokemonByDex.get(4)!;
  // The pool for Charmander: normal and fire moves, minus ember (its starting move) and buffs.
  const attacks = [
    ...new Set([
      ...(data.movesByType.get('normal') ?? []),
      ...(data.movesByType.get('fire') ?? []),
    ]),
  ].filter((m) => m.id !== 'ember' && m.kind !== 'buff');
  const select = () => document.querySelector<HTMLSelectElement>('[data-testid="repertoire-move"]');
  const values = () => [...select()!.options].map((o) => o.value);

  it('has the drop-down only once Repertoire is bought', async () => {
    await mount(save({}));
    expect(select()).toBeNull();
    document.body.replaceChildren();
    await mount(save({ 'extra-move': 1 }));
    expect(select()).toBeTruthy();
    expect(select()!.closest('.upg-item')?.textContent).toContain('Repertoire');
  });

  it('offers Random (the default) and the pool, minus the starting move, buffs and bans', async () => {
    expect(charmander.types).toContain('fire');
    const banned = attacks[0]!.id;
    await mount(save({ 'extra-move': 1, ban: 1 }, undefined, { bans: [banned] }));
    expect(select()!.value).toBe('');
    expect(select()!.options[0]?.textContent).toBe('Random');
    expect(values().slice(1).sort()).toEqual(
      attacks
        .filter((m) => m.id !== banned)
        .map((m) => m.id)
        .sort(),
    );
    expect(values()).not.toContain('ember');
    // Each option shows the move's name and type.
    const flamethrower = attacks.find((m) => m.type === 'fire')!;
    const option = [...select()!.options].find((o) => o.value === flamethrower.id);
    expect(option?.textContent).toBe(`${flamethrower.name} · Fire`);
  });

  it('shows the saved choice, and saves a new one (Random sends null)', async () => {
    const [a, b] = attacks as [Move, Move];
    const { app } = await mount(save({ 'extra-move': 1 }, undefined, { repertoire: a.id }));
    expect(select()!.value).toBe(a.id);
    select()!.value = b.id;
    select()!.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(app.api.setMoves).toHaveBeenCalledWith(4, { repertoire: b.id }));
    await vi.waitFor(() => expect(select()!.value).toBe(b.id));
    select()!.value = '';
    select()!.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(app.api.setMoves).toHaveBeenLastCalledWith(4, { repertoire: null }),
    );
    await vi.waitFor(() => expect(select()!.value).toBe(''));
  });

  it('works with the keys and the pad, keeping the focus on it after saving', async () => {
    // happy-dom doesn't lay out: every control gets a box, so the nav sees them.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
      right: 10,
      bottom: 10,
      x: 0,
      y: 0,
    } as DOMRect);
    try {
      const { app, screen } = await mount(save({ 'extra-move': 1 }));
      const nav = new MenuNav(() => screen.el);
      select()!.focus();
      // The keys: the arrows are the drop-down's own (the browser changes its value).
      expect(nav.key('ArrowDown', select())).toBe(false);
      // The pad: right steps to the next option and saves it.
      nav.press('right');
      const first = values()[1]!;
      await vi.waitFor(() =>
        expect(app.api.setMoves).toHaveBeenCalledWith(4, { repertoire: first }),
      );
      await vi.waitFor(() => expect(select()!.value).toBe(first));
      expect(document.activeElement).toBe(select());
      nav.press('left');
      await vi.waitFor(() =>
        expect(app.api.setMoves).toHaveBeenLastCalledWith(4, { repertoire: null }),
      );
      expect(document.activeElement).toBe(select());
    } finally {
      vi.restoreAllMocks();
    }
  });
});
