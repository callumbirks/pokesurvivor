// @vitest-environment happy-dom
// The "Mega Capable" badge on the collection's and the Pokémon picker's cells (pokemonCell), and
// its line in the detail panel.
import { loadGameData } from '@pokesurvivor/data';
import { describe, expect, it, vi } from 'vitest';
import type * as Icons from '../icons.js';
import type { App } from './app.js';
import { pokemonPicker } from './pokemon-picker.js';
import { pokemonCell, pokemonDetail } from './pokemon-views.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', async (orig) => ({
  ...(await orig<typeof Icons>()),
  iconImg: (name: string) => Object.assign(document.createElement('img'), { alt: name }),
}));

const data = loadGameData();
const cell = (dex: number) =>
  pokemonCell(data.pokemonByDex.get(dex)!, {
    testid: `cell-${dex}`,
    own: true,
    selected: false,
    partner: false,
    hasShiny: false,
    shiny: false,
    onClick: () => undefined,
  });

describe('the Mega Capable badge', () => {
  it('marks the Pokémon that can Mega Evolve, and only them', () => {
    expect(cell(6).querySelector('[data-testid="mega-badge"]')).not.toBeNull();
    expect(cell(382).querySelector('[data-testid="mega-badge"]')).not.toBeNull();
    expect(cell(25).querySelector('[data-testid="mega-badge"]')).toBeNull();
    expect(cell(4).querySelector('[data-testid="mega-badge"]')).toBeNull();
  });

  it('shows the Mega symbol, or the Rusted Sword for Zacian', () => {
    expect(cell(6).querySelector<HTMLImageElement>('.badge-mega img')?.alt).toBe('mega');
    expect(cell(888).querySelector<HTMLImageElement>('.badge-mega img')?.src).toContain(
      '/items/rusted-sword.png',
    );
  });

  it('has a tooltip on hover', () => {
    const c = cell(6);
    document.body.append(c);
    const badge = c.querySelector<HTMLElement>('[data-testid="mega-badge"]')!;
    expect(badge.getAttribute('aria-label')).toBe(
      'Mega Capable · Can Mega Evolve in runs, using Charizardite X',
    );
    badge.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    const tip = document.querySelector<HTMLElement>('[data-testid="tooltip"]')!;
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain('Mega Capable');
    badge.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    expect(tip.hidden).toBe(true);
    c.remove();
  });

  it('says it in the detail panel too (no hover on touch)', () => {
    const detail = (dex: number) => {
      const root = document.createElement('div');
      root.append(
        ...pokemonDetail(data.pokemonByDex.get(dex)!, {
          own: true,
          hasShiny: false,
          viewShiny: false,
          onShiny: () => undefined,
        }),
      );
      return root.querySelector('[data-testid="mega-line"]')?.textContent ?? null;
    };
    expect(detail(889)).toContain('Can take up the Rusted Shield in runs');
    expect(detail(25)).toBeNull();
  });

  it('is on the cells of the run Pokémon picker', () => {
    const owned = Object.fromEntries([6, 25, 384].map((d) => [String(d), 1]));
    const app = {
      save: { owned, shiny: {}, partner: { dex: 25, shiny: false }, upgrades: {}, prestige: {} },
      events: { on: () => () => undefined },
    } as unknown as App;
    const picker = pokemonPicker(app, {
      id: 'solo',
      confirm: { label: () => 'Go', act: () => undefined },
    } as unknown as Parameters<typeof pokemonPicker>[1]);
    const badge = (dex: number) =>
      picker.el.querySelector(`.cell[data-dex="${dex}"] [data-testid="mega-badge"]`);
    expect(picker.el.querySelector('.cell[data-dex="25"]')).not.toBeNull();
    expect(badge(6)).not.toBeNull();
    expect(badge(384)).not.toBeNull();
    expect(badge(25)).toBeNull();
    picker.destroy();
  });
});
