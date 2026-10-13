import { z } from 'zod';
import { DexSchema } from './common.js';

/**
 * Physical size of a Pokémon in the world, derived from its sprite sheets (see `sprites.json`) so
 * the simulation doesn't need the large sprite manifest. World units: 1 art pixel = 2 units.
 */
export const BodySchema = z.strictObject({
  dex: DexSchema,
  /** Collision radius at scale 1: `clamp(idleFrameWidth · 0.22, 5, 26) · 2`. */
  radius: z.number().positive(),
  /** Visual height above the feet at scale 1: the Idle ground anchor's y · 2. */
  height: z.number().positive(),
  /** Floats in its sprite, so it passes over rocks and water. */
  hovers: z.boolean(),
  /** Has shiny sprites (only those can be shiny). */
  shiny: z.boolean(),
});
export type Body = z.infer<typeof BodySchema>;

export const BodiesFileSchema = z.strictObject({ bodies: z.array(BodySchema).min(1) });
export type BodiesFile = z.infer<typeof BodiesFileSchema>;
