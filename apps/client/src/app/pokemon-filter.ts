// Searching, filtering and sorting Pokémon (the Pokémon picker, the collection). DOM-free: the
// screens pass the names in the player's language (`pokemonName`) and the save's collection.
import type { Pokemon } from '@pokesurvivor/data';

/** What the filters look at in a save. */
export interface CollectionView {
  owned: Readonly<Record<string, { at: number }>>;
  shiny: Readonly<Record<string, unknown>>;
  /** dex → upgrade id → level bought. */
  upgrades: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface PokemonFilter {
  /** Name (or dex number) search, as typed. */
  query: string;
  /** Generation (region); 0: all. */
  gen: number;
  /** A type id; '': any. */
  type: string;
  /** 1–5; 0: any. */
  rarity: number;
  /** Only those whose shiny is owned. */
  shiny: boolean;
}

export const NO_FILTER: Readonly<PokemonFilter> = {
  query: '',
  gen: 0,
  type: '',
  rarity: 0,
  shiny: false,
};

export const POKEMON_SORTS = ['dex', 'name', 'upgrades', 'rarity', 'newest'] as const;
export type PokemonSort = (typeof POKEMON_SORTS)[number];

/** Lower case without accents or punctuation, so "flabebe" finds Flabébé and "mr mime" Mr. Mime. */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/♀/g, 'f')
    .replace(/♂/g, 'm')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Whether `query` finds the Pokémon: its folded name contains it, or it's its dex number. */
export function matchesQuery(name: string, dex: number, query: string): boolean {
  const q = query.trim().replace(/^#/, '');
  if (!q) return true;
  if (/^\d+$/.test(q)) return Number(q) === dex;
  const folded = foldName(q);
  return !folded || foldName(name).includes(folded);
}

/** The upgrade levels bought for a Pokémon, all upgrades together (the shop's "N levels"). */
export function upgradeLevel(save: CollectionView, dex: number): number {
  return Object.values(save.upgrades[String(dex)] ?? {}).reduce((a, b) => a + b, 0);
}

/** The Pokémon that pass `filter` (any of `mons`: the caller decides about owning them). */
export function filterPokemon(
  mons: readonly Pokemon[],
  filter: Partial<PokemonFilter>,
  save: CollectionView,
  nameOf: (dex: number) => string,
): Pokemon[] {
  const f = { ...NO_FILTER, ...filter };
  return mons.filter(
    (p) =>
      (!f.gen || p.gen === f.gen) &&
      (!f.type || p.types.includes(f.type as Pokemon['types'][number])) &&
      (!f.rarity || p.rarity === f.rarity) &&
      (!f.shiny || !!save.shiny[String(p.dex)]) &&
      matchesQuery(nameOf(p.dex), p.dex, f.query),
  );
}

/**
 * Sorted copy: by dex number, name, upgrade levels (most first), rarity (rarest first) or newest
 * caught. Ties go by dex number.
 */
export function sortPokemon(
  mons: readonly Pokemon[],
  sort: PokemonSort,
  save: CollectionView,
  nameOf: (dex: number) => string,
): Pokemon[] {
  const byDex = (a: Pokemon, b: Pokemon) => a.dex - b.dex;
  const caught = (p: Pokemon) => save.owned[String(p.dex)]?.at ?? 0;
  const compare: Record<PokemonSort, (a: Pokemon, b: Pokemon) => number> = {
    dex: byDex,
    name: (a, b) => nameOf(a.dex).localeCompare(nameOf(b.dex)) || byDex(a, b),
    upgrades: (a, b) => upgradeLevel(save, b.dex) - upgradeLevel(save, a.dex) || byDex(a, b),
    rarity: (a, b) => b.rarity - a.rarity || byDex(a, b),
    newest: (a, b) => caught(b) - caught(a) || byDex(a, b),
  };
  return [...mons].sort(compare[sort]);
}

/** How many of the filters (not the search) are on. */
export function activeFilters(filter: PokemonFilter): number {
  return (
    Number(!!filter.gen) + Number(!!filter.type) + Number(!!filter.rarity) + Number(filter.shiny)
  );
}
