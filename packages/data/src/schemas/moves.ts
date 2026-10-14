import { z } from 'zod';
import { IdSchema, PokemonTypeSchema, TextSchema } from './common.js';

/** How a move behaves (implemented by the sim; see original implementation). */
export const MOVE_KINDS = [
  'projectile',
  'melee',
  'beam',
  'orbit',
  'nova',
  'aura',
  'buff',
  'boomerang',
  'chain',
  'mine',
  'meteor',
  'turret',
  'dash',
  'trail',
  'cone',
] as const;
export const MoveKindSchema = z.enum(MOVE_KINDS);
export type MoveKind = z.infer<typeof MoveKindSchema>;

/** Numeric move parameters. Upgrades and evolutions modify these by key. */
export const MOVE_STATS = [
  'cooldown',
  'damage',
  'radius',
  'arc',
  'width',
  'knockback',
  'speed',
  'count',
  'spread',
  'pierce',
  'lifetime',
  'size',
  'homing',
  'burn',
  'poison',
  'slow',
  'amount',
  'duration',
  'stacks',
  'rate',
  'range',
  'hexBonus',
] as const;
export const MoveStatSchema = z.enum(MOVE_STATS);
export type MoveStat = z.infer<typeof MoveStatSchema>;

export const MoveStatsSchema = z.partialRecord(MoveStatSchema, z.number());
export type MoveStats = z.infer<typeof MoveStatsSchema>;

/** A change applied to a move's stats; see `modifierRules` for how each key combines. */
export const MoveModsSchema = z.partialRecord(MoveStatSchema, z.number());

export const MoveUpgradeSchema = z.strictObject({ text: TextSchema, mods: MoveModsSchema });
export type MoveUpgrade = z.infer<typeof MoveUpgradeSchema>;

/** What a `buff` move stacks. */
export const BuffStatSchema = z.enum(['attack', 'speed', 'defense', 'regen']);

export const MoveSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  type: PokemonTypeSchema,
  kind: MoveKindSchema,
  description: TextSchema,
  stats: MoveStatsSchema,
  buffStat: BuffStatSchema.optional(),
  /**
   * At max level, the move evolves if the player has taken the `requires` level-up stat card at
   * least once this run.
   */
  evolution: z.strictObject({ id: IdSchema, name: TextSchema, requires: IdSchema }).optional(),
});
export type Move = z.infer<typeof MoveSchema>;

export const MovesFileSchema = z.strictObject({
  /**
   * How mods combine with a move's stats: multiplicative keys multiply an existing value,
   * additive keys add (missing counts as 0). Any other key, or a multiplicative key the move
   * doesn't have, is assigned as-is.
   */
  modifierRules: z.strictObject({
    multiplicative: z.array(MoveStatSchema),
    additive: z.array(MoveStatSchema),
  }),
  /** Level 1 → 5: upgrade `i` takes a move from level i+1 to i+2. Shared by every move of a kind. */
  upgradeLadders: z.record(MoveKindSchema, z.array(MoveUpgradeSchema).min(1)),
  /** Boost applied on evolution, per kind. Buffs don't evolve. */
  evolutionBoosts: z.partialRecord(MoveKindSchema, MoveUpgradeSchema),
  /** Starting move by primary type, for Pokémon that aren't starters. */
  startingMoves: z.record(PokemonTypeSchema, IdSchema),
  /** Pokémon learn moves of their types plus every `normal` move. */
  moves: z.array(MoveSchema).min(1),
});
export type MovesFile = z.infer<typeof MovesFileSchema>;
