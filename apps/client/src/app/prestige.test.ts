// @vitest-environment happy-dom
import { loadGameData } from '@pokesurvivor/data';
import { describe, expect, it, vi } from 'vitest';
import { pokemonCell, pokemonDetail } from './pokemon-views.js';
import { prestigeBox, prestigeGains, prestigeOf, stars } from './prestige.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', () => ({
  iconImg: (id: string) => Object.assign(document.createElement('img'), { alt: id }),
  iconUrl: () => '',
  typeColor: () => '#ffffff',
}));

const data = loadGameData();
const { maxStars } = data.tuning.prestige;

describe('prestige stars', () => {
  it('draws one gold star per prestige, none without, and no more than the maximum', () => {
    expect(stars(0)).toBeNull();
    expect(stars(undefined)).toBeNull();
    expect(stars(2)?.textContent).toBe('★★');
    expect(stars(2)?.getAttribute('aria-label')).toBe('Prestige 2');
    expect(stars(99)?.textContent).toBe('★'.repeat(maxStars));
  });

  it('reads the stars from the save', () => {
    expect(prestigeOf({ prestige: { 25: 3 } }, 25)).toBe(3);
    expect(prestigeOf({ prestige: {} }, 25)).toBe(0);
    expect(prestigeOf({}, 25)).toBe(0); // a save cached before prestige
  });

  it('lists the gains of every stat from the tuning', () => {
    expect(prestigeGains(0)).toEqual([]);
    const two = prestigeGains(2).map((g) => g.id);
    expect(two).toEqual(['hp', 'damage', 'speed', 'cooldown', 'defense', 'crit']);
    expect(prestigeBox(0)).toBeNull();
    expect(prestigeBox(1)?.querySelectorAll('.chip')).toHaveLength(3);
  });

  it('shows on the grid cells and the detail panel of owned Pokémon', () => {
    const p = data.pokemonByDex.get(25)!;
    const cell = (own: boolean, prestige?: number) =>
      pokemonCell(p, {
        testid: 'c',
        own,
        selected: false,
        partner: false,
        hasShiny: false,
        shiny: false,
        prestige,
        onClick: () => {},
      });
    expect(cell(true, 2).querySelector('[data-testid="stars"]')?.textContent).toBe('★★');
    expect(cell(true).querySelector('[data-testid="stars"]')).toBeNull();
    expect(cell(false, 2).querySelector('[data-testid="stars"]')).toBeNull();

    const detail = document.createElement('div');
    detail.append(
      ...pokemonDetail(p, {
        own: true,
        hasShiny: false,
        viewShiny: false,
        onShiny: () => {},
        prestige: 1,
      }),
    );
    expect(detail.querySelector('[data-testid="detail-name"]')?.textContent).toBe('Pikachu ★');
    expect(detail.querySelectorAll('.bar b')).toHaveLength(3);
    expect(detail.querySelector('[data-testid="prestige-box"]')).toBeTruthy();
  });
});
