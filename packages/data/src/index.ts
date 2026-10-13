import { z } from 'zod';

/** The 18 elemental types. Placeholder until the legacy data is extracted (phase 1). */
export const POKEMON_TYPES = [
  'normal',
  'fire',
  'water',
  'grass',
  'electric',
  'ice',
  'fighting',
  'poison',
  'ground',
  'flying',
  'psychic',
  'bug',
  'rock',
  'ghost',
  'dragon',
  'dark',
  'steel',
  'fairy',
] as const;

export const PokemonTypeSchema = z.enum(POKEMON_TYPES);
export type PokemonType = z.infer<typeof PokemonTypeSchema>;
