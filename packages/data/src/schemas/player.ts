import { z } from 'zod';
import { HexColorSchema, IdSchema, RaritySchema, RewardSchema, TextSchema } from './common.js';

/** Player run modifiers that items, level-up cards and altar powers change. */
export const PLAYER_STATS = [
  'attackMul',
  'speedMul',
  'cooldownMul',
  'xpMul',
  'coinMul',
  'magnet',
  'damageReduction',
  'regen',
] as const;
export const PlayerStatSchema = z.enum(PLAYER_STATS);
export type PlayerStat = z.infer<typeof PlayerStatSchema>;

/** `stat ×= value` or `stat += value`; with `perMaxHp`, the value is a fraction of max HP. */
export const StatEffectSchema = z.strictObject({
  stat: PlayerStatSchema,
  op: z.enum(['mul', 'add']),
  value: z.number(),
  perMaxHp: z.literal(true).optional(),
  /** Upper bound after applying. */
  cap: z.number().optional(),
});
export type StatEffect = z.infer<typeof StatEffectSchema>;

// ---------------- permanent upgrades (bought with coins between runs) ----------------

export const UpgradeSchema = z.strictObject({
  id: IdSchema,
  icon: IdSchema,
  name: TextSchema,
  description: TextSchema,
  maxLevel: z.number().int().positive(),
  /** Cost of level `l` (0-based): `round(baseCost · costGrowth^l / 10) · 10`. */
  baseCost: z.number().int().positive(),
  costGrowth: z.number().min(1),
  /** What each level adds to the matching perk. */
  perLevel: z.number().positive(),
});
export type Upgrade = z.infer<typeof UpgradeSchema>;
export const UpgradesFileSchema = z.array(UpgradeSchema).min(1);

// ---------------- held items (one per run) ----------------

export const ItemSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  description: TextSchema,
  /** Applied while held, undone when swapped. */
  effects: z.array(StatEffectSchema),
  /** Tuning for items that react to events (fatal hit, damage dealt, casting, melee hits). */
  params: z.record(z.string(), z.number()).optional(),
});
export type Item = z.infer<typeof ItemSchema>;
export const ItemsFileSchema = z.array(ItemSchema).min(1);

// ---------------- level-up cards ----------------

export const StatCardEffectSchema = z.discriminatedUnion('type', [
  /**
   * `cap` is the card's ceiling, and the card stops being offered once it's reached. `add`: a bound
   * on the stat itself (Armor's damage reduction), or with `capOf: "cards"` on the amount the
   * card's own picks have added (Synthesis). `mul`: a bound on the multiplier the card's own picks
   * have built up; for a multiplier below 1 (Reflexes' cooldown) it's a floor. Bounds on what the
   * cards built leave held items and permanent upgrades outside them. A pick that would pass the
   * ceiling is clamped to it.
   */
  z.strictObject({
    type: z.literal('stat'),
    ...StatEffectSchema.shape,
    /** What an `add` card's `cap` bounds: the stat (default) or what the card's picks added. */
    capOf: z.enum(['stat', 'cards']).optional(),
  }),
  /**
   * Raise max HP and heal the same amount. `cap` (with `capOf: "cards"`, the only kind) bounds the
   * max HP the card's own picks have added; upgrades, items and prestige stay on top. A pick that
   * would pass it adds (and heals) only up to it, and the card stops being offered there.
   */
  z.strictObject({
    type: z.literal('maxHp'),
    value: z.number().positive(),
    cap: z.number().positive().optional(),
    capOf: z.literal('cards').optional(),
  }),
  z.strictObject({ type: z.literal('heal'), maxHpFraction: z.number().positive() }),
]);

export const StatCardSchema = z.strictObject({
  id: IdSchema,
  icon: IdSchema,
  name: TextSchema,
  /**
   * Shown with the rolled amount: `{value}` (max HP, HP per second) or `{percent}` (the bonus of a
   * multiplier or a fraction, as a percentage).
   */
  description: TextSchema,
  /** Rolls a rarity (default). `false`: always the base effect, shown without a rarity. */
  rarity: z.boolean().optional(),
  effect: StatCardEffectSchema,
});
export type StatCard = z.infer<typeof StatCardSchema>;

export const LevelUpFileSchema = z.strictObject({
  /** Cards offered per level-up. A ready move evolution is always one of them. */
  cardsOffered: z.number().int().positive(),
  /** Candidate counts drawn before the weighted pick. */
  newMoveCandidates: z.number().int().positive(),
  statCandidates: z.number().int().positive(),
  /** No more buff moves are offered once the player has this many. */
  maxBuffMoves: z.number().int().positive(),
  maxMoveSlots: z.number().int().positive(),
  /** Relative weights of each card type in the weighted pick. */
  weights: z.strictObject({
    newMove: z.number().positive(),
    evolution: z.number().positive(),
    moveUpgrade: z.number().positive(),
    /** A stat card that unlocks a waiting evolution. */
    statForEvolution: z.number().positive(),
    /** A stat card while the player still has free move slots. */
    statWithFreeSlots: z.number().positive(),
    stat: z.number().positive(),
  }),
  /**
   * Stat card rarities. A rarity multiplies the card's bonus: the part above 1 of a `mul` effect
   * (1.06 at ×1.5 is 1.09), or the value of an `add` / max-HP effect.
   */
  rarity: z
    .strictObject({
      /** Lowest first. `gachaRarity`: the gacha rarity whose colour the card's frame uses. */
      tiers: z
        .array(
          z.strictObject({
            id: IdSchema,
            multiplier: z.number().positive(),
            gachaRarity: z.number().int().positive(),
          }),
        )
        .min(1),
      /** Weights per tier versus run minute; interpolate, then hold the last point. */
      odds: z
        .array(
          z.strictObject({
            minute: z.number().nonnegative(),
            weights: z.array(z.number().nonnegative()),
          }),
        )
        .min(1)
        .refine(
          (points) =>
            points[0]?.minute === 0 &&
            points.every((p, i) => i === 0 || p.minute > points[i - 1]!.minute),
          'Start at minute zero and use strictly increasing minutes',
        ),
    })
    .refine(
      (r) =>
        r.odds.every((p) => p.weights.length === r.tiers.length && p.weights.some((w) => w > 0)),
      'Every odds point needs one weight per tier, and some weight above zero',
    )
    .refine(
      (r) => new Set(r.tiers.map((t) => t.id)).size === r.tiers.length,
      'Tier ids must be unique',
    ),
  statCards: z.array(StatCardSchema).min(1),
});
export type LevelUpFile = z.infer<typeof LevelUpFileSchema>;

// ---------------- missions ----------------

/** Progress events the sim and the account system emit. */
export const ProgressEventSchema = z.enum([
  'defeat',
  'chest',
  'item',
  'evolve',
  'rift-win',
  'run-end',
  'mission-done',
]);

export const MissionSchema = z.strictObject({
  id: IdSchema,
  event: ProgressEventSchema,
  /** Only events that match count: a boss, a daily mission, or a Pokémon of the rolled type. */
  filter: z.enum(['boss', 'daily', 'has-type']).optional(),
  /** What an event is worth (1 if absent). */
  value: z.enum(['minutes', 'level', 'coins']).optional(),
  /** `add` sums events, `max` keeps the best one. */
  mode: z.enum(['add', 'max']),
  /** The mission rolls a Pokémon type when it's handed out. */
  param: z.literal('type').optional(),
  /** One is rolled when the mission is handed out. */
  goals: z.array(z.number().int().positive()).min(1),
  reward: RewardSchema,
  /** `{count}` is the goal, `{type}` the rolled type's name. */
  text: TextSchema,
  /** Used instead of `text` when the goal is 1. */
  textSingular: TextSchema.optional(),
});
export type Mission = z.infer<typeof MissionSchema>;

export const MissionsFileSchema = z.strictObject({
  dailyCount: z.number().int().positive(),
  weeklyCount: z.number().int().positive(),
  daily: z.array(MissionSchema).min(1),
  weekly: z.array(MissionSchema).min(1),
});
export type MissionsFile = z.infer<typeof MissionsFileSchema>;

// ---------------- achievements ----------------

/** What an achievement measures in the account save. */
export const AchievementMetricSchema = z.enum([
  'pokemon-owned',
  'shinies-owned',
  'gacha-pulls',
  'best-time-minutes',
  'best-level',
  'runs',
  'total-defeated',
  'bosses-defeated',
  'move-evolutions',
  'distinct-moves-evolved',
  'distinct-items-found',
  'rift-wins',
  'arenas-won',
  'legendaries-defeated',
  'legendary-defeated',
  'missions-done',
  'group-runs',
]);
export type AchievementMetric = z.infer<typeof AchievementMetricSchema>;

export const AchievementSchema = z.strictObject({
  id: IdSchema,
  category: IdSchema,
  /** Medal: 1 bronze, 2 silver, 3 gold. */
  tier: z.number().int().min(1).max(3),
  name: TextSchema,
  description: TextSchema,
  metric: AchievementMetricSchema,
  goal: z.number().int().positive(),
  reward: RewardSchema,
  /** Profile title it unlocks. */
  title: TextSchema.optional(),
  /** For `legendary-defeated`: which legendary. */
  dex: z.number().int().positive().optional(),
});
export type Achievement = z.infer<typeof AchievementSchema>;

export const AchievementsFileSchema = z.strictObject({
  categories: z.array(z.strictObject({ id: IdSchema, name: TextSchema })),
  achievements: z.array(AchievementSchema).min(1),
});
export type AchievementsFile = z.infer<typeof AchievementsFileSchema>;

// ---------------- gacha ----------------

export const GachaFileSchema = z
  .strictObject({
    /** Ticket cost of a single pull and of a ×10 pull (×10 can also be paid with one ×10 ticket). */
    cost: z.strictObject({
      single: z.number().int().positive(),
      multi: z.number().int().positive(),
      multiCount: z.number().int().positive(),
      multiTickets10: z.number().int().positive(),
    }),
    /** Relative weights per rarity for each pull. */
    rates: z.array(z.strictObject({ rarity: RaritySchema, weight: z.number().positive() })),
    /**
     * Soft pity: from the `from`-th pull since the last 5★ on a banner, the 5★ chance is the base
     * rate plus `stepPerPull` per pull (`from` itself gets one step). The extra chance is taken from
     * the other rarities in proportion to their weights.
     */
    softPity: z.strictObject({
      from: z.number().int().positive(),
      stepPerPull: z.number().positive().max(1),
    }),
    /** The `hardPity`-th pull without a 5★ on a banner is a 5★. Counted per banner. */
    hardPity: z.number().int().positive(),
    /** The last pull of a ×10 is at least this rarity if none of the others was. */
    multiGuaranteeMinRarity: RaritySchema,
    /** Chance a pull comes out shiny (only Pokémon with shiny sprites). */
    shinyRate: z.number().positive().max(1),
    /** Coins for a duplicate, by rarity; duplicate shinies give `shinyDuplicateMultiplier` times as many. */
    duplicateRefund: z.array(
      z.strictObject({ rarity: RaritySchema, coins: z.number().int().positive() }),
    ),
    shinyDuplicateMultiplier: z.number().positive(),
    rarities: z.array(
      z.strictObject({ rarity: RaritySchema, name: TextSchema, color: HexColorSchema }),
    ),
    /** One banner per generation; it contains that generation's Pokémon. */
    banners: z.array(
      z.strictObject({
        id: IdSchema,
        gen: z.number().int().min(1).max(9),
        name: TextSchema,
        colors: z.array(HexColorSchema).length(3),
      }),
    ),
  })
  .refine((g) => g.softPity.from < g.hardPity, {
    message: 'softPity.from must come before hardPity',
    path: ['softPity', 'from'],
  });
export type GachaFile = z.infer<typeof GachaFileSchema>;
