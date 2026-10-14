import { loadGameData } from '@pokesurvivor/data';
import { describe, expect, it } from 'vitest';
import {
  activeFilters,
  filterPokemon,
  foldName,
  matchesQuery,
  NO_FILTER,
  sortPokemon,
  upgradeLevel,
  type CollectionView,
} from './pokemon-filter.js';

const data = loadGameData();
const nameOf = (dex: number) => data.pokemonByDex.get(dex)?.name ?? `#${dex}`;
const mon = (dex: number) => data.pokemonByDex.get(dex)!;
const dexes = (list: { dex: number }[]) => list.map((p) => p.dex);

// Bulbasaur, Charmander, Pikachu, Mewtwo, Chikorita, Flabébé (Kalos), Nidoran♀.
const mons = [1, 4, 25, 150, 152, 669, 29].map(mon);
const save: CollectionView = {
  owned: {
    '1': { at: 100 },
    '4': { at: 300 },
    '25': { at: 200 },
    '150': { at: 50 },
    '152': { at: 400 },
    '669': { at: 10 },
    '29': { at: 20 },
  },
  shiny: { '25': { at: 200 } },
  upgrades: { '4': { hp: 2, speed: 1 }, '152': { hp: 1 } },
};

describe('search', () => {
  it('folds case, accents and punctuation', () => {
    expect(foldName('Flabébé')).toBe('flabebe');
    expect(foldName('Mr. Mime')).toBe('mrmime');
    expect(foldName('Nidoran♀')).toBe('nidoranf');
  });

  it('finds names by any part, and dex numbers', () => {
    expect(matchesQuery('Pikachu', 25, 'KACH')).toBe(true);
    expect(matchesQuery('Flabébé', 669, 'flabe')).toBe(true);
    expect(matchesQuery('Pikachu', 25, '25')).toBe(true);
    expect(matchesQuery('Pikachu', 25, '#25')).toBe(true);
    expect(matchesQuery('Pikachu', 25, '2')).toBe(false);
    expect(matchesQuery('Pikachu', 25, 'char')).toBe(false);
    expect(matchesQuery('Pikachu', 25, '  ')).toBe(true);
  });

  it('searches in the names it is given (the player’s language)', () => {
    const german = (dex: number) => (dex === 4 ? 'Glumanda' : nameOf(dex));
    expect(dexes(filterPokemon(mons, { query: 'gluma' }, save, german))).toEqual([4]);
    expect(filterPokemon(mons, { query: 'gluma' }, save, nameOf)).toEqual([]);
  });
});

describe('filters', () => {
  it('passes everything with no filter', () => {
    expect(filterPokemon(mons, NO_FILTER, save, nameOf)).toHaveLength(mons.length);
  });

  it('filters by region, type, rarity and shiny, together', () => {
    expect(dexes(filterPokemon(mons, { gen: 2 }, save, nameOf))).toEqual([152]);
    expect(dexes(filterPokemon(mons, { type: 'fire' }, save, nameOf))).toEqual([4]);
    expect(dexes(filterPokemon(mons, { type: 'grass' }, save, nameOf))).toEqual([1, 152]);
    expect(dexes(filterPokemon(mons, { shiny: true }, save, nameOf))).toEqual([25]);
    const legend = mon(150).rarity;
    expect(dexes(filterPokemon(mons, { rarity: legend }, save, nameOf))).toContain(150);
    expect(
      dexes(filterPokemon(mons, { gen: 1, type: 'grass', query: 'bul' }, save, nameOf)),
    ).toEqual([1]);
    expect(filterPokemon(mons, { gen: 2, type: 'fire' }, save, nameOf)).toEqual([]);
  });

  it('counts the filters that are on (not the search)', () => {
    expect(activeFilters({ ...NO_FILTER, query: 'pika' })).toBe(0);
    expect(activeFilters({ ...NO_FILTER, gen: 1, type: 'fire', rarity: 2, shiny: true })).toBe(4);
  });
});

describe('sort', () => {
  it('sums the upgrade levels', () => {
    expect(upgradeLevel(save, 4)).toBe(3);
    expect(upgradeLevel(save, 25)).toBe(0);
  });

  it('sorts by dex, name, upgrades, rarity and newest, ties by dex', () => {
    expect(dexes(sortPokemon(mons, 'dex', save, nameOf))).toEqual([1, 4, 25, 29, 150, 152, 669]);
    expect(dexes(sortPokemon(mons, 'name', save, nameOf))).toEqual([1, 4, 152, 669, 150, 29, 25]);
    expect(dexes(sortPokemon(mons, 'upgrades', save, nameOf)).slice(0, 3)).toEqual([4, 152, 1]);
    expect(dexes(sortPokemon(mons, 'newest', save, nameOf))).toEqual([152, 4, 25, 1, 150, 29, 669]);
    const byRarity = sortPokemon(mons, 'rarity', save, nameOf);
    for (let i = 1; i < byRarity.length; i++)
      expect(byRarity[i - 1]!.rarity).toBeGreaterThanOrEqual(byRarity[i]!.rarity);
  });

  it('does not change the list it is given', () => {
    const copy = [...mons];
    sortPokemon(mons, 'name', save, nameOf);
    expect(mons).toEqual(copy);
  });
});
