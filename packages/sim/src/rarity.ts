// Stat card rarities (levelup.json `rarity`): offered stat cards roll a tier, whose multiplier
// scales the card's bonus. The odds move from the first point towards the later ones over the run.
import type { LevelUpFile, StatCard } from '@pokesurvivor/data';
import type { Rand } from './rng.js';

type Rarity = LevelUpFile['rarity'];
type Tier = Rarity['tiers'][number];

/** Tier weights at a run minute: interpolated between the odds points, the last one held. */
export function rarityWeights(odds: Rarity['odds'], minute: number): number[] {
  const first = odds[0]!;
  if (minute <= first.minute) return first.weights;
  for (let i = 1; i < odds.length; i++) {
    const a = odds[i - 1]!;
    const b = odds[i]!;
    if (minute <= b.minute) {
      const f = (minute - a.minute) / (b.minute - a.minute);
      return a.weights.map((w, k) => w + ((b.weights[k] ?? 0) - w) * f);
    }
  }
  return odds.at(-1)!.weights;
}

/** A tier id, drawn with the odds at `minute`. */
export function rollRarity(rarity: Rarity, minute: number, rand: Rand): string {
  const weights = rarityWeights(rarity.odds, minute);
  let r = rand() * weights.reduce((a, w) => a + w, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return rarity.tiers[i]!.id;
  }
  // Rounding at the top end: the last tier with any weight.
  const last = weights.findLastIndex((w) => w > 0);
  return rarity.tiers[last]!.id;
}

/** The tier of a card's rarity id (none: no rarity, or an unknown id). */
export function rarityTier(rarity: Rarity, id: string | undefined): Tier | undefined {
  return id === undefined ? undefined : rarity.tiers.find((t) => t.id === id);
}

/**
 * A stat card's effect at a rarity multiplier. The bonus scales, not the multiplier itself: Power
 * 1.06 at ×1.5 is 1.09, Reflexes 0.95 at ×2 is 0.90. Heals don't scale.
 */
export function scaledCardEffect(e: StatCard['effect'], m: number): StatCard['effect'] {
  if (m === 1 || e.type === 'heal') return e;
  if (e.type === 'maxHp') return { ...e, value: e.value * m };
  return { ...e, value: e.op === 'mul' ? 1 + (e.value - 1) * m : e.value * m };
}
