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

/** Cost of buying level `currentLevel + 1`, as in the legacy shop (`legacy/js/data/upgrades.js`). */
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
 * Defaults. The run caps are generous first guesses (legacy pays ~12 coins/min for time plus
 * kills, bosses and pickups, times up to +64% from upgrades); tune them from real run data.
 */
export const DEFAULT_ECONOMY: EconomyConfig = {
  startingCoins: 500,
  upgrades: upgradesFromData(),
  runCaps: {
    maxDurationS: 3 * 60 * 60,
    maxLevel: 200,
    killsPerMinute: 600,
    bossesPerMinute: 2,
    coinsFlat: 200,
    coinsPerMinute: 300,
    ticketsX1Flat: 2,
    ticketsX1PerMinute: 1,
    ticketsX10Flat: 0,
    ticketsX10PerMinute: 0.2,
    shiniesFlat: 1,
    shiniesPerMinute: 0.2,
    shiniesMax: 5,
    chestsFlat: 2,
    chestsPerMinute: 0.5,
    itemsFlat: 2,
    itemsPerMinute: 0.5,
    evolutionsFlat: 1,
    evolutionsPerMinute: 0.5,
    riftWinsFlat: 1,
    riftWinsPerMinute: 0.34,
    rescuesFlat: 1,
    rescuesPerMinute: 0.1,
    rescuesMax: 3,
  },
};
