import { describe, expect, it } from 'vitest';
import {
  allUpgradesMaxed,
  canPrestige,
  clampStars,
  loadGameData,
  prestigeBonus,
} from '../src/index.js';

describe('prestige', () => {
  const { tuning, upgrades } = loadGameData();
  const prestige = tuning.prestige;
  const maxLevels = Object.fromEntries(upgrades.map((u) => [u.id, u.maxLevel]));
  const maxed = { ...maxLevels };

  it('scales each stat by its own per-star value', () => {
    expect(prestigeBonus(prestige, 0)).toEqual({
      hpMul: 1,
      damageMul: 1,
      speedMul: 1,
      cooldownMul: 1,
      defense: 0,
      crit: 0,
    });
    const two = prestigeBonus(prestige, 2);
    expect(two.hpMul).toBeCloseTo(1 + 2 * prestige.perStar.hp);
    expect(two.damageMul).toBeCloseTo(1 + 2 * prestige.perStar.damage);
    expect(two.speedMul).toBeCloseTo(1 + 2 * prestige.perStar.speed);
    expect(two.cooldownMul).toBeCloseTo(1 - 2 * prestige.perStar.cooldown);
    expect(two.defense).toBeCloseTo(2 * prestige.perStar.defense);
    expect(two.crit).toBeCloseTo(2 * prestige.perStar.crit);
  });

  it('clamps stars to whole numbers up to the maximum', () => {
    expect(clampStars(prestige, undefined)).toBe(0);
    expect(clampStars(prestige, -1)).toBe(0);
    expect(clampStars(prestige, 1.7)).toBe(1);
    expect(clampStars(prestige, 99)).toBe(prestige.maxStars);
  });

  it('needs every upgrade maxed and a star left', () => {
    expect(allUpgradesMaxed(maxLevels, maxed)).toBe(true);
    expect(canPrestige(prestige, maxLevels, maxed, 0)).toBe(true);
    expect(canPrestige(prestige, maxLevels, maxed, prestige.maxStars - 1)).toBe(true);
    expect(canPrestige(prestige, maxLevels, maxed, prestige.maxStars)).toBe(false);
    expect(canPrestige(prestige, maxLevels, undefined, 0)).toBe(false);
    for (const id of Object.keys(maxLevels)) {
      const short = { ...maxed, [id]: (maxed[id] ?? 1) - 1 };
      expect(canPrestige(prestige, maxLevels, short, 0)).toBe(false);
    }
  });
});
