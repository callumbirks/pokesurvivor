import { z } from 'zod';
import { RangeSchema } from './common.js';

const Seconds = z.number().positive();
const Chance = z.number().positive().max(1);

/** A multiplier versus run minute: from minute zero, strictly increasing minutes. */
const MinuteCurve = z
  .array(
    z.strictObject({
      minute: z.number().nonnegative(),
      multiplier: z.number().positive(),
    }),
  )
  .min(2)
  .refine(
    (points) =>
      points[0]?.minute === 0 &&
      points.every((p, i) => i === 0 || p.minute > points[i - 1]!.minute),
    'Start at minute zero and use strictly increasing minutes',
  );

/** Named tuning constants from the legacy systems. Times are in seconds. */
export const TuningFileSchema = z.strictObject({
  spawner: z.strictObject({
    /** Max enemies alive at once. */
    cap: z.number().int().positive(),
    /** Above this fraction of `cap`, new spawns are elites. */
    eliteFrom: z.number().positive().max(1),
    /** Spawn-rate multiplier (fewer, stronger enemies) and the matching damage/xp multipliers. */
    density: z.number().positive(),
    damageK: z.number().positive(),
    /** Regular wild damage versus run minute; interpolate, then hold the last value. */
    damageCurve: MinuteCurve,
    /**
     * Regular wild HP versus run minute, on top of the built-in time scaling (`enemyScale`):
     * interpolate, then hold the last value.
     */
    hpCurve: MinuteCurve,
    /** Max regular contact/shot damage as a fraction of target HP, before weather; 0 disables. */
    regularHitCapFraction: z.number().nonnegative().max(1),
    directionBias: z.strictObject({
      smoothingSeconds: Seconds,
      aheadShare: z.number().min(0).max(1),
      minSpeed: z.number().nonnegative(),
    }),
    xpK: z.number().positive(),
    shinyRate: Chance,
  }),
  stragglers: z.strictObject({
    /** Per living target, only when an enemy's previous target went down or left. */
    relocationsPerSecond: z.number().positive(),
    /** Maximum saved relocations; ordinary catch-up remains unrestricted. */
    burst: z.number().int().positive(),
    /** Continuous seconds outside every living player’s view before catch-up. */
    unseenSeconds: Seconds,
    /** Rear-centred placement arc used when the rear half is selected. */
    rearArcDegrees: z.number().positive().max(180),
    /** Share of moving-player catch-up placed in the forward half instead of the rear arc. */
    aheadShare: z.number().min(0).max(1),
  }),
  rift: z.strictObject({
    /** Every `checkEvery` s after `startAfter` s, a rift opens with `chance` (rising per miss). */
    checkEvery: Seconds,
    chance: Chance,
    startAfter: Seconds,
    /** How long an open rift waits to be entered. */
    ttl: Seconds,
    /** Arena radius in tiles and time limit of the legendary fight. */
    arenaRadius: z.number().int().positive(),
    arenaTime: Seconds,
    /** Legend HP only: multiply the existing base by (1 + a * max(0, minute - m0)) ** p.
     * No cap: the curve continues growing after the measured 6–20 minute window.
     */
    hpCurve: z.strictObject({
      /** Run minute where extra HP growth begins; earlier rifts retain the base HP. */
      m0: z.number().nonnegative(),
      /** Positive growth per minute after m0, before exponentiation. */
      a: z.number().positive(),
      /** Positive exponent; independent of contact/shot damage and player prestige. */
      p: z.number().positive(),
    }),
    /** Extra legend HP for coordinated teams larger than two:
     * 1 + perPlayerAfterDuo * max(0, players - 2) * progress ** rampPower,
     * progress = clamp((minute - rampFromMinute) / (rampToMinute - rampFromMinute), 0, 1).
     * Solo/duo HP and legend damage remain unchanged.
     */
    coopHp: z
      .strictObject({
        /** Extra multiplier per player beyond the first two after the ramp. */
        perPlayerAfterDuo: z.number().nonnegative(),
        /** Run minute when the additional co-op HP begins to ramp. */
        rampFromMinute: z.number().nonnegative(),
        /** Run minute when the full co-op uplift applies; greater than rampFromMinute. */
        rampToMinute: z.number().positive(),
        /** Eases the onset; values above one keep early uplift small. */
        rampPower: z.number().positive(),
        /** Replace rift.hpCurve for teams of three or more. Same uncapped formula;
         * keeps the early large-team fit independent of untested solo/duo HP.
         */
        hpCurve: z.strictObject({
          /** Run minute when large-team time growth begins. */
          m0: z.number().nonnegative(),
          /** Positive growth per minute after m0. */
          a: z.number().positive(),
          /** Positive exponent; affects HP only. */
          p: z.number().positive(),
        }),
      })
      .refine((c) => c.rampToMinute > c.rampFromMinute, {
        message: 'co-op rampToMinute must exceed rampFromMinute',
        path: ['rampToMinute'],
      }),
    /** Distance from a player a rift opens at (before the placement fallbacks). */
    distance: RangeSchema,
    /** Chance the legendary is shiny (if it has shiny sprites). */
    shinyChance: Chance,
    /** Legendaries not yet beaten (by the players) are this many times likelier. */
    unbeatenWeight: z.number().positive(),
    /** The legendary drops this many tickets and coin piles of `rewardCoinValue` (plus a boss's). */
    rewardTickets: z.number().int().nonnegative(),
    rewardCoinDrops: z.number().int().nonnegative(),
    rewardCoinValue: z.number().int().positive(),
    /** Seconds before the team is sent back to the map after a win / a loss. */
    returnAfterWin: Seconds,
    returnAfterLoss: Seconds,
    /** Fraction of max HP restored on exit: revive the downed or heal the living by this much. */
    exitHeal: z.number().positive().max(1),
  }),
  events: z.strictObject({
    /** A mid-run event (horde, golden hour, lost Pokémon) every `every` s. */
    every: RangeSchema,
    duration: Seconds,
    /** Time to bring a lost Pokémon home. */
    lostTime: Seconds,
    /** Treasure thieves: first and following appearance times, and how long they stay. */
    thiefFirst: RangeSchema,
    thiefNext: RangeSchema,
    thiefLife: Seconds,
    /** Chance a treasure thief is Gholdengo (drops a ×10 ticket) instead of Meowth (coins). */
    goldThiefChance: Chance,
    /** Enemies a typed horde starts with (× the co-op spawn rate). */
    hordeBurst: z.number().int().positive(),
    /** Chance a rescued lost Pokémon joins the collection; coins if it was already owned. */
    lostJoinChance: Chance,
    rescueOwnedCoins: z.number().int().nonnegative(),
  }),
  combat: z.strictObject({ critMultiplier: z.number().positive() }),
  /** Earned late-game growth: level-up offers that keep damage scaling after the early game. */
  lateGrowth: z.strictObject({
    offers: z.strictObject({
      /** Run minute from which level-ups guarantee offensive stat cards. */
      fromMinute: z.number().nonnegative(),
      /** How many of the offered cards are one of `statIds` (while any isn't at its cap). */
      guaranteedOffenseSlots: z.number().int().nonnegative(),
      /** Level-up stat card ids (levelup.json) that count as offensive. */
      statIds: z.array(z.string()).min(1),
      /** Never let a guaranteed card take the slot of a ready move evolution. */
      preserveReadyEvolution: z.boolean(),
    }),
  }),
  /** Kill-streak damage bonus, per player: every kill credited to a player adds a stack. */
  momentum: z
    .strictObject({
      /** Move damage per stack: ×(1 + perStack · stacks). */
      perStack: z.number().nonnegative(),
      /** The stack cap grows linearly from `maxStacksStart` at the start of the run to
       * `maxStacks` at `maxStacksFullMinute`, then holds. */
      maxStacksStart: z.number().int().positive(),
      maxStacksFullMinute: z.number().nonnegative(),
      maxStacks: z.number().int().positive(),
      /** Seconds after the last kill before stacks start to decay. */
      graceSeconds: z.number().nonnegative(),
      /** Stacks lost per second once decaying (gradually, not all at once). */
      decayPerSecond: z.number().positive(),
    })
    .refine((m) => m.maxStacksStart <= m.maxStacks, {
      message: 'momentum.maxStacksStart must not exceed maxStacks',
      path: ['maxStacksStart'],
    }),
  poison: z.strictObject({
    /** Scale only poison's percent-max-HP damage against map bosses and rift legends.
     * Flat damage, tick interval, stacks and regular-enemy poison stay unchanged.
     */
    bossFactor: z.number().nonnegative().max(1),
  }),
  enemyShields: z.strictObject({
    /** Shield HP is capped at this fraction of the recipient's max HP. */
    maxHpFraction: Chance,
    duration: Seconds,
    cooldown: Seconds,
    initialCooldown: RangeSchema,
    /** Per recipient, measured from application: overlapping casters cannot refill a shield. */
    reapplyCooldown: Seconds,
    /** Query circle touches the recipient's body, as in legacy. */
    radius: z.number().positive(),
    /** Includes the caster if it is among the nearest eligible targets. */
    maxTargets: z.number().int().positive(),
    affectsBosses: z.boolean(),
  }),
  enemyHeals: z.strictObject({
    /** Per-application cap and maximum stored healing credit. */
    maxHpFraction: Chance,
    /** Only this share of actual HP damage can be restored; shield damage earns no credit. */
    damageFraction: z.number().positive().lt(1),
    cooldown: Seconds,
    initialCooldown: RangeSchema,
    /** Shared across all casters, counted from a successful heal. */
    recipientCooldown: Seconds,
    radius: z.number().positive(),
    maxTargets: z.number().int().positive(),
    affectsBosses: z.boolean(),
    affectsShielded: z.boolean(),
  }),
  pickups: z.strictObject({
    max: z.number().int().positive(),
    /** Chance a regular enemy drops a gacha ticket. */
    ticketDropRate: Chance,
    /** Chance a boss / a rift legendary drops a ×10 ticket. */
    bossTicket10Chance: Chance,
    legendaryTicket10Chance: Chance,
  }),
  /**
   * Pokémon prestige (stars): reached by maxing every permanent upgrade, which then reset. Each
   * star adds `perStar.<stat>` to that stat's prestige factor (see `prestigeBonus`); enemies never
   * scale with it.
   */
  /**
   * Defence is toughness: damage taken = incoming ÷ (1 + defence), where defence sums the Armor
   * upgrade, cards, items, prestige and Harden (1 = +100%, half damage). `max` is the most that
   * counts (5 = +500%, a sixth of the damage).
   */
  defense: z.strictObject({ max: z.number().positive() }),
  prestige: z.strictObject({
    maxStars: z.number().int().positive().max(9),
    perStar: z.strictObject({
      /** Max HP, damage and speed: × (1 + perStar × stars). */
      hp: z.number().nonnegative().max(1),
      damage: z.number().nonnegative().max(1),
      speed: z.number().nonnegative().max(1),
      /** Move cooldowns: × (1 − perStar × stars). */
      cooldown: z.number().nonnegative().max(0.3),
      /** Defence (+% toughness, like the Armor upgrade): + perStar × stars. */
      defense: z.number().nonnegative().max(1),
      /** Critical hit chance (0–1, like the Critical Hit upgrade): + perStar × stars. */
      crit: z.number().nonnegative().max(0.3),
    }),
  }),
});
export type TuningFile = z.infer<typeof TuningFileSchema>;
