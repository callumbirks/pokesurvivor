/**
 * Economy numbers the server enforces. Passed into `buildApp` so tests can tune them; the
 * upgrade table will move to `packages/data` once the data extraction lands.
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
}

/** Cost of buying level `currentLevel + 1`, as in the legacy shop. */
export function upgradeCost(def: UpgradeDef, currentLevel: number): number {
  return Math.round((def.baseCost * Math.pow(def.growth, currentLevel)) / 10) * 10;
}

/** The legacy upgrade table (`legacy/js/data/upgrades.js`). */
const LEGACY_UPGRADES: Record<string, UpgradeDef> = {
  hp: { maxLevel: 10, baseCost: 60, growth: 1.35 },
  atk: { maxLevel: 10, baseCost: 80, growth: 1.38 },
  spd: { maxLevel: 8, baseCost: 70, growth: 1.4 },
  cd: { maxLevel: 8, baseCost: 90, growth: 1.42 },
  def: { maxLevel: 8, baseCost: 80, growth: 1.4 },
  regen: { maxLevel: 5, baseCost: 120, growth: 1.5 },
  magnet: { maxLevel: 6, baseCost: 50, growth: 1.4 },
  xp: { maxLevel: 8, baseCost: 100, growth: 1.42 },
  coins: { maxLevel: 8, baseCost: 120, growth: 1.45 },
  moves: { maxLevel: 1, baseCost: 1500, growth: 1 },
  crit: { maxLevel: 10, baseCost: 90, growth: 1.4 },
  reroll: { maxLevel: 5, baseCost: 150, growth: 1.6 },
  ban: { maxLevel: 3, baseCost: 300, growth: 1.9 },
};

/**
 * Defaults. The run caps are generous first guesses (legacy pays ~12 coins/min for time plus
 * kills, bosses and pickups, times up to +64% from upgrades); tune them from real run data.
 */
export const DEFAULT_ECONOMY: EconomyConfig = {
  startingCoins: 500,
  upgrades: LEGACY_UPGRADES,
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
  },
};
