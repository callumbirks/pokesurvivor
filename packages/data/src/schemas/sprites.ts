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
  /** Ground anchor inside the frame: where the feet (and the shadow's centre) go. */
  anchorX: z.number(),
  anchorY: z.number(),
  /**
   * The opaque pixels' box inside the frame, over every frame of the facing-down row (`right`
   * and `bottom` exclusive). Art often reaches a few pixels below the anchor (tails, legs), so
   * layouts that stand a sprite on a line use `bottom`, not `anchorY`.
   */
  bounds: z.strictObject({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    right: z.number().int().positive(),
    bottom: z.number().int().positive(),
  }),
});
export type SpriteAnimation = z.infer<typeof SpriteAnimationSchema>;

export const PokemonSpritesSchema = z
  .strictObject({
    dex: DexSchema,
    /**
     * An alternate form (`megas.json` kind): its sheets are under `{dex}-{form}/` instead of
     * `{dex}/`. Absent: the base form.
     */
    form: z
      .string()
      .regex(/^[a-z]+$/)
      .optional(),
    /** Content hash of the Pokémon's sheets; append as `?v=` to bust long-lived caches. */
    hash: z.string().regex(/^[0-9a-f]{8}$/),
    shadowSize: z.number().int().min(0),
    /** Floats in its sprite, so it passes over rocks and water. */
    hovers: z.boolean(),
    /** Has shiny sheets under `{dex}/s/`. */
    shiny: z.boolean(),
    /**
     * Every animation for a base form. An alternate form may lack some (not Idle or Walk): the
     * client falls back to a similar one (see its `sprites.ts`).
     */
    animations: z.partialRecord(AnimationNameSchema, SpriteAnimationSchema),
    /** Shiny sheets whose geometry differs from the normal ones (rare). */
    shinyAnimations: z.partialRecord(AnimationNameSchema, SpriteAnimationSchema).optional(),
  })
  .refine((p) => p.shiny || !p.shinyAnimations, {
    message: 'shinyAnimations without shiny sheets',
  })
  .refine((p) => (p.form ? ['Idle', 'Walk'] : ANIMATIONS).every((a) => a in p.animations), {
    message: 'missing animations (a base form needs all of them, a form Idle and Walk)',
  });
export type PokemonSprites = z.infer<typeof PokemonSpritesSchema>;

export const SpriteManifestSchema = z.strictObject({
  /**
   * URL prefix the server serves `assets/pokemon/` at: `{basePath}/{key}/[s/]{Animation}.png`, where
   * the key is the dex, or `{dex}-{form}` for an alternate form.
   */
  basePath: z.string().startsWith('/'),
  pokemon: z.array(PokemonSpritesSchema),
});
export type SpriteManifest = z.infer<typeof SpriteManifestSchema>;
