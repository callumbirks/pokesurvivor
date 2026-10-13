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
  }),
  combat: z.strictObject({ critMultiplier: z.number().positive() }),
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
