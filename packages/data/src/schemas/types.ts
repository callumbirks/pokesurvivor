import { z } from 'zod';
import { HexColorSchema, PokemonTypeSchema, TextSchema } from './common.js';

/** Multiplier from the main-series games (6th gen on); ×1 entries are omitted. */
export const GameEffectivenessSchema = z.union([z.literal(0), z.literal(0.5), z.literal(2)]);

export const TypeChartSchema = z.strictObject({
  types: z.array(
    z.strictObject({ id: PokemonTypeSchema, name: TextSchema, color: HexColorSchema }),
  ),
  /** attacker → defender → game multiplier. */
  chart: z.record(PokemonTypeSchema, z.partialRecord(PokemonTypeSchema, GameEffectivenessSchema)),
  /**
   * The survivor softens the games' multipliers (you can't switch Pokémon): each one is replaced
   * by these, multiplied across both defending types, then clamped to [min, max].
   */
  softened: z.strictObject({
    superEffective: z.number(),
    notVeryEffective: z.number(),
    immune: z.number(),
  }),
  min: z.number(),
  max: z.number(),
});
export type TypeChart = z.infer<typeof TypeChartSchema>;
