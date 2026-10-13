import { z } from 'zod';
import { DexSchema, RangeSchema } from './common.js';

export const ENEMY_BEHAVIORS = [
  'chase',
  'charger',
  'ranged',
  'tank',
  'healer',
  'shielder',
  'summoner',
  'bomber',
  'beamer',
  'zoner',
  'fan',
  'jumper',
  'runner',
  'thief',
] as const;
export const EnemyBehaviorSchema = z.enum(ENEMY_BEHAVIORS);
export type EnemyBehavior = z.infer<typeof EnemyBehaviorSchema>;

/**
 * A spawn tier: from second `from`, wild Pokémon whose base stat total is within `bst` can appear.
 * Each run rolls `castSize` of them; their stats are these, scaled by each Pokémon's own HP/speed.
 */
export const EnemyTierSchema = z.strictObject({
  from: z.number().min(0),
  bst: RangeSchema,
  hp: z.number().positive(),
  speed: z.number().positive(),
  damage: z.number().positive(),
  xp: z.number().positive(),
  castSize: z.number().int().positive(),
});

/** A boss slot: at second `at`, a random non-legendary Pokémon with a BST within `bst`. */
export const BossSlotSchema = z.strictObject({
  at: z.number().positive(),
  hp: z.number().positive(),
  damage: z.number().positive(),
  xp: z.number().positive(),
  bst: RangeSchema,
});

export const EnemiesFileSchema = z.strictObject({
  tiers: z.array(EnemyTierSchema).min(1),
  bossSlots: z.array(BossSlotSchema).min(1),
  /**
   * After `fromMinute`, enemy HP (and, less, damage) grows by `exp(min(30, k · m²))`, where `m` is
   * the minutes past `fromMinute`.
   */
  lateGame: z.strictObject({ fromMinute: z.number().positive(), k: z.number().positive() }),
  /** Pokémon with a fixed behaviour; the rest get one from their types and a hash of their dex. */
  fixedBehaviors: z.strictObject({
    healer: z.array(DexSchema),
    shielder: z.array(DexSchema),
    bomber: z.array(DexSchema),
  }),
  /** Summoners and the Pokémon they call in. */
  summons: z.array(z.strictObject({ summoner: DexSchema, minion: DexSchema })),
});
export type EnemiesFile = z.infer<typeof EnemiesFileSchema>;
