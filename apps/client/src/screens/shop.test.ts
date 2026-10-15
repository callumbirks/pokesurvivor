// @vitest-environment happy-dom
import { loadGameData, prestigeBonus } from '@pokesurvivor/data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../app/app.js';
import type { Save } from '../app/api.js';
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

function save(upgrades: Record<string, number>, prestige?: number): Save {
  return {
    coins: 0,
    partner: { dex: 4, shiny: false },
    owned: { 4: { at: 0, from: 'starter' } },
    shiny: {},
    upgrades: { 4: upgrades },
    prestige: prestige ? { 4: prestige } : {},
    moveBans: { 4: [] },
    moveBindings: {},
  } as unknown as Save;
}

function fakeApp(s: Save) {
  const app = {
    save: s,
    api: {
      request: vi.fn(() => Promise.resolve({ upgrades: rules })),
      prestige: vi.fn(() => Promise.resolve(save({}, (s.prestige?.['4'] ?? 0) + 1))),
    },
    events: { on: () => () => {} },
    act: async (_: unknown, fn: () => Promise<unknown>) => fn(),
    setSave: vi.fn((next: Save) => (app.save = next)),
    go: vi.fn(),
  };
  return app;
}

async function mount(s: Save) {
  const app = fakeApp(s);
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
