import { z } from 'zod';
import { RangeSchema } from './common.js';

const Seconds = z.number().positive();
const Chance = z.number().positive().max(1);

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
    xpK: z.number().positive(),
    shinyRate: Chance,
  }),
  stragglers: z.strictObject({
    /** Per living target, only when an enemy's previous target went down or left. */
    relocationsPerSecond: z.number().positive(),
    /** Maximum saved relocations; ordinary catch-up remains unrestricted. */
    burst: z.number().int().positive(),
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
});
export type TuningFile = z.infer<typeof TuningFileSchema>;
