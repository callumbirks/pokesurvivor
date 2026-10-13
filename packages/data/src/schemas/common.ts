import { z } from 'zod';

/** The 18 elemental types, in the legacy order (missions roll a type by index). */
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

/** Stable, English, kebab-case identifier. */
export const IdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'expected a kebab-case id');

/** National Pokédex number. */
export const DexSchema = z.number().int().positive();

export const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'expected a #rrggbb colour');

/** Display text shown to players (English). */
export const TextSchema = z.string().min(1);

/** Inclusive numeric range `[min, max]`. */
export const RangeSchema = z.tuple([z.number(), z.number()]).refine(([a, b]) => a <= b, {
  message: 'range min must not exceed max',
});

export const RaritySchema = z.number().int().min(1).max(5);

/** Account rewards: coins, gacha tickets and ×10 gacha tickets. */
export const RewardSchema = z.strictObject({
  coins: z.number().int().positive().optional(),
  tickets: z.number().int().positive().optional(),
  tickets10: z.number().int().positive().optional(),
});
export type Reward = z.infer<typeof RewardSchema>;
