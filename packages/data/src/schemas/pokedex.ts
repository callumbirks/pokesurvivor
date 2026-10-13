import { z } from 'zod';
import { DexSchema, IdSchema, PokemonTypeSchema, RaritySchema, TextSchema } from './common.js';

export const PokemonSchema = z.strictObject({
  dex: DexSchema,
  id: IdSchema,
  name: TextSchema,
  types: z.array(PokemonTypeSchema).min(1).max(2),
  /** Game stats derived from the base stats (see legacy tools/fetch_pokedex.py). */
  hp: z.number().positive(),
  speed: z.number().positive(),
  attack: z.number().positive(),
  /** Base stat total. */
  bst: z.number().int().positive(),
  /** Gacha rarity, 1–5 stars. */
  rarity: RaritySchema,
  /** Generation, which is also its gacha banner. */
  gen: z.number().int().min(1).max(9),
  /** Offered by the personality test. */
  starter: z.boolean(),
  /** Legendary or mythical: only appears in rifts. */
  legendary: z.boolean(),
});
export type Pokemon = z.infer<typeof PokemonSchema>;

export const PokedexSchema = z.array(PokemonSchema).min(1);
