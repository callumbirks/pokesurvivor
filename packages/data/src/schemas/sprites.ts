import { z } from 'zod';
import { DexSchema } from './common.js';

export const ANIMATIONS = ['Idle', 'Walk', 'Attack', 'Shoot', 'Charge', 'Hurt', 'Faint'] as const;
export const AnimationNameSchema = z.enum(ANIMATIONS);
export type AnimationName = z.infer<typeof AnimationNameSchema>;

/**
 * One sprite sheet (SpriteCollab AnimData): `frames` columns × `rows` directions.
 * Rows: 0 Down, 1 DownRight, 2 Right, 3 UpRight, 4 Up, 5 UpLeft, 6 Left, 7 DownLeft.
 */
export const SpriteAnimationSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Duration of each frame, in 1/60 s. */
  durations: z.array(z.number().int().positive()).min(1),
  /** Ground anchor inside the frame. */
  anchorX: z.number(),
  anchorY: z.number(),
});
export type SpriteAnimation = z.infer<typeof SpriteAnimationSchema>;

export const PokemonSpritesSchema = z
  .strictObject({
    dex: DexSchema,
    /** Content hash of the Pokémon's sheets; append as `?v=` to bust long-lived caches. */
    hash: z.string().regex(/^[0-9a-f]{8}$/),
    shadowSize: z.number().int().min(0),
    /** Floats in its sprite, so it passes over rocks and water. */
    hovers: z.boolean(),
    /** Has shiny sheets under `{dex}/s/`. */
    shiny: z.boolean(),
    animations: z.record(AnimationNameSchema, SpriteAnimationSchema),
    /** Shiny sheets whose geometry differs from the normal ones (rare). */
    shinyAnimations: z.partialRecord(AnimationNameSchema, SpriteAnimationSchema).optional(),
  })
  .refine((p) => p.shiny || !p.shinyAnimations, {
    message: 'shinyAnimations without shiny sheets',
  });
export type PokemonSprites = z.infer<typeof PokemonSpritesSchema>;

export const SpriteManifestSchema = z.strictObject({
  /** URL prefix the server serves `assets/pokemon/` at: `{basePath}/{dex}/[s/]{Animation}.png`. */
  basePath: z.string().startsWith('/'),
  pokemon: z.array(PokemonSpritesSchema),
});
export type SpriteManifest = z.infer<typeof SpriteManifestSchema>;
