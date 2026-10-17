import { getServerData } from '../data.js';

/**
 * Economy numbers the server enforces. Passed into `buildApp` so tests can tune them. The
 * upgrade table comes from `packages/data` (`upgrades.json`).
 */
export interface EconomyConfig {
  /** Coins credited to a new save. */
  startingCoins: number;
  /** Per-Pokémon upgrades that can be bought with coins, by id. */
  upgrades: Record<string, UpgradeDef>;
  runCaps: RunCaps;
}

export interface UpgradeDef {
  maxLevel: number;
  baseCost: number;
  /** Cost multiplier per level already bought. */
  growth: number;
}

/**
 * Sanity caps for client-reported solo runs. Values over a cap are clamped, not rejected, and
 * the original claim is kept on the run for auditing. Rates are per minute survived.
 */
export interface RunCaps {
  /** Longest run that can be reported; the duration is also capped at the time since start. */
  maxDurationS: number;
  maxLevel: number;
  killsPerMinute: number;
  bossesPerMinute: number;
  /** Coins: `coinsFlat + coinsPerMinute * minutes`. */
  coinsFlat: number;
  coinsPerMinute: number;
  ticketsX1Flat: number;
  ticketsX1PerMinute: number;
  ticketsX10Flat: number;
  ticketsX10PerMinute: number;
  /** Gems: `min(gemsMax, gemsFlat + gemsPerMinute * minutes)`. */
  gemsFlat: number;
  gemsPerMinute: number;
  gemsMax: number;
  /** Wild shinies caught: `min(shiniesMax, shiniesFlat + shiniesPerMinute * minutes)`. */
  shiniesFlat: number;
  shiniesPerMinute: number;
  shiniesMax: number;
  /** `RunProgress` counters, each `flat + perMinute * minutes`. */
  chestsFlat: number;
  chestsPerMinute: number;
  itemsFlat: number;
  itemsPerMinute: number;
  evolutionsFlat: number;
  evolutionsPerMinute: number;
  riftWinsFlat: number;
  riftWinsPerMinute: number;
  /** Lost Pokémon that join the collection: `min(rescuesMax, flat + perMinute * minutes)`. */
  rescuesFlat: number;
  rescuesPerMinute: number;
  rescuesMax: number;
}

/** Cost of buying level `currentLevel + 1`, using the shared upgrade cost formula. */
export function upgradeCost(def: UpgradeDef, currentLevel: number): number {
  return Math.round((def.baseCost * Math.pow(def.growth, currentLevel)) / 10) * 10;
}

/** The upgrade table from `upgrades.json`, keyed by upgrade id. */
export function upgradesFromData(): Record<string, UpgradeDef> {
  return Object.fromEntries(
    getServerData().upgrades.map((u) => [
      u.id,
      { maxLevel: u.maxLevel, baseCost: u.baseCost, growth: u.costGrowth },
    ]),
  );
}

/**
 * Defaults. The run caps are an anti-cheat ceiling at about 1.5–2× the most an honest solo run
 * can earn per minute (`plans/run-caps-2026-10-17.md` in the project files has the derivation),
 * so only implausible claims are capped. That honest maximum is worked out from the sim's
 * rewards, at the rates real players reach (the v8 export of 30+ minute runs: up to 780 kills
 * a minute over a run, 0.82 bosses and 0.66 rift wins a minute, level 359 at two hours) and the
 * locked-chest rate of a chest-hunting bot (`pnpm --filter @pokesurvivor/sim rewards --chests`:
 * 0.28 a minute). Per minute, at 800 kills, 0.95 bosses and 0.75 rift wins:
 * - coins: 12 for time + 200 for kills (1 per 4) + 76 for bosses (80 each) + about 240 picked up
 *   (50 per boss, 80 more per rift win, thieves, golden hour, chests, rescues) + 17 for rescues
 *   already owned, ≈ 545, times 2.46 (Fortune maxed and the Amulet Coin) ≈ 1350 → 2000;
 * - ×1 tickets: 2 from kills (`ticketDropRate`) + 2.25 from rift wins (3 each) + chests, rescues
 *   and wild legendaries ≈ 5.2 → 8;
 * - ×10 tickets: rift legendaries (20%), bosses (10%), chests (15%), gold thieves ≈ 0.24 → 0.5,
 *   with a flat 3 because they are few and lucky runs get several;
 * - kills 800 → 1500, bosses 0.95 → 2, rift wins ~0.7 → 1.2, items (a boss's or a chest's, each
 *   equipped) ~1.1 → 2, chests 0.28 → 0.5, shinies (1 per 4096 spawns at 800 kills) 0.2 → 0.4.
 * Level is only a stat (359 seen at two hours), so its cap is far out of reach. Gems are left
 * where they were.
 */
export const DEFAULT_ECONOMY: EconomyConfig = {
  startingCoins: 500,
  upgrades: upgradesFromData(),
  runCaps: {
    maxDurationS: 3 * 60 * 60,
    maxLevel: 1000,
    killsPerMinute: 1500,
    bossesPerMinute: 2,
    coinsFlat: 500,
    coinsPerMinute: 2000,
    ticketsX1Flat: 5,
    ticketsX1PerMinute: 8,
    ticketsX10Flat: 3,
    ticketsX10PerMinute: 0.5,
    // About 5 gems drop in a typical 15-minute run (`tuning.pickups`); strong players kill more.
    gemsFlat: 3,
    gemsPerMinute: 1.5,
    gemsMax: 100,
    // The max is the per-minute limit at 3 hours: 800 kills a minute find about 35 shinies.
    shiniesFlat: 2,
    shiniesPerMinute: 0.4,
    shiniesMax: 75,
    chestsFlat: 2,
    chestsPerMinute: 0.5,
    itemsFlat: 2,
    itemsPerMinute: 2,
    evolutionsFlat: 1,
    evolutionsPerMinute: 0.5,
    riftWinsFlat: 2,
    riftWinsPerMinute: 1.2,
    // A lost Pokémon comes at most every other event (~9 min) and joins 1 time in 5: about 4 in
    // 3 hours, so the rate already allows plenty; only the max (3 before) held back long runs.
    rescuesFlat: 1,
    rescuesPerMinute: 0.1,
    rescuesMax: 10,
  },
};
