// Pokémon prestige (stars): once every permanent upgrade of a Pokémon is maxed it can be
// prestiged, which resets its upgrades and gives it a star (up to `tuning.prestige.maxStars`).
// Shared by the sim (which applies the bonus), the server (eligibility) and the client (display).
import type { TuningFile } from './schemas/index.js';

export type PrestigeTuning = TuningFile['prestige'];

/** What a Pokémon's stars do to its stats, as the sim applies them. */
export interface PrestigeBonus {
  /** Max HP multiplier. */
  hpMul: number;
  /** Damage (attack) multiplier. */
  damageMul: number;
  /** Movement speed multiplier. */
  speedMul: number;
  /** Move cooldown multiplier (below 1). */
  cooldownMul: number;
  /** Added to damage reduction (0–1), like the Armor upgrade. */
  damageReduction: number;
  /** Added to critical hit chance (0–1), like the Critical Hit upgrade. */
  crit: number;
}

/** Stars as stored or sent: whole, between 0 and `maxStars`. */
export function clampStars(tuning: PrestigeTuning, stars: number | undefined): number {
  if (!stars || !Number.isFinite(stars)) return 0;
  return Math.max(0, Math.min(tuning.maxStars, Math.floor(stars)));
}

/**
 * The bonus of `stars` stars. Each star adds `perStar` linearly: HP, damage and speed are
 * multiplied by `1 + perStar × stars`, cooldowns by `1 − perStar × stars`, and damage reduction
 * and crit chance gain `perStar × stars` points, the way their upgrades and cards add up.
 */
export function prestigeBonus(tuning: PrestigeTuning, stars: number | undefined): PrestigeBonus {
  const n = clampStars(tuning, stars);
  const { perStar } = tuning;
  return {
    hpMul: 1 + perStar.hp * n,
    damageMul: 1 + perStar.damage * n,
    speedMul: 1 + perStar.speed * n,
    cooldownMul: 1 - perStar.cooldown * n,
    damageReduction: perStar.damageTaken * n,
    crit: perStar.crit * n,
  };
}

/** Whether every upgrade in `maxLevels` (id → max level) is at its max in `levels`. */
export function allUpgradesMaxed(
  maxLevels: Readonly<Record<string, number>>,
  levels: Readonly<Record<string, number>> | undefined,
): boolean {
  return Object.entries(maxLevels).every(([id, max]) => (levels?.[id] ?? 0) >= max);
}

/** Whether a Pokémon with these upgrade levels and stars can be prestiged now. */
export function canPrestige(
  tuning: PrestigeTuning,
  maxLevels: Readonly<Record<string, number>>,
  levels: Readonly<Record<string, number>> | undefined,
  stars: number | undefined,
): boolean {
  return clampStars(tuning, stars) < tuning.maxStars && allUpgradesMaxed(maxLevels, levels);
}
