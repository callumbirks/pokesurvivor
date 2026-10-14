import type { GachaFile, Pokemon } from '@pokesurvivor/data';
import { pick } from '../random.js';
import type { Rng } from '../random.js';

/**
 * The gacha rules, ported from original `systems/gacha.js`. Pure: every number comes from
 * `gacha.json` and every random draw from the injected `rng`, so tests can seed it.
 */

/** The Pokémon a banner can give: its generation's Pokémon that have sprites, by rarity. */
export interface BannerPool {
  id: string;
  gen: number;
  all: readonly Pokemon[];
  byRarity: ReadonlyMap<number, readonly Pokemon[]>;
}

export function buildBannerPool(
  banner: { id: string; gen: number },
  pokedex: readonly Pokemon[],
  hasSprite: (dex: number) => boolean,
): BannerPool {
  const all = pokedex.filter((p) => p.gen === banner.gen && hasSprite(p.dex));
  const byRarity = new Map<number, Pokemon[]>();
  for (const p of all) {
    const list = byRarity.get(p.rarity) ?? [];
    list.push(p);
    byRarity.set(p.rarity, list);
  }
  return { id: banner.id, gen: banner.gen, all, byRarity };
}

/** The banner's three strongest 5★ (by base stat total), for its poster (original `featured`). */
export function featuredOf(pool: BannerPool): number[] {
  return [...(pool.byRarity.get(5) ?? [])]
    .sort((a, b) => b.bst - a.bst)
    .slice(0, 3)
    .map((p) => p.dex);
}

/**
 * The nearest non-empty rarity pool (some generations have almost-empty rarities): tries the
 * rarity, then -1, +1, -2, +2, … Falls back to the whole banner (original `poolNear`).
 */
export function poolNear(
  pool: BannerPool,
  rarity: number,
): { rarity: number; list: readonly Pokemon[] } {
  for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
    const r = rarity + d;
    if (r < 1 || r > 5) continue;
    const list = pool.byRarity.get(r);
    if (list && list.length > 0) return { rarity: r, list };
  }
  return { rarity, list: pool.all };
}

/**
 * The chance of a 5★ on the pull that brings a banner's pity to `pity`: the base rate, plus
 * `softPity.stepPerPull` per pull from `softPity.from`, and 1 from `hardPity`.
 */
export function fiveStarChance(config: GachaFile, pity: number): number {
  if (pity >= config.hardPity) return 1;
  const total = config.rates.reduce((sum, r) => sum + r.weight, 0);
  const base = (config.rates.find((r) => r.rarity === 5)?.weight ?? 0) / total;
  const steps = Math.max(0, pity - config.softPity.from + 1);
  return Math.min(1, base + steps * config.softPity.stepPerPull);
}

/**
 * The rarity weights, normalised to 1, for the pull that brings a banner's pity to `pity`: 5★ at
 * `fiveStarChance`, the other rarities sharing the rest in proportion to their weights.
 */
export function ratesAt(config: GachaFile, pity: number): GachaFile['rates'] {
  const five = fiveStarChance(config, pity);
  const othersTotal = config.rates
    .filter((r) => r.rarity !== 5)
    .reduce((sum, r) => sum + r.weight, 0);
  return config.rates.map((r) => ({
    rarity: r.rarity,
    weight: r.rarity === 5 ? five : (r.weight / othersTotal) * (1 - five),
  }));
}

/** A weighted rarity of at least `min` (original `rollRarity`). Zero weights never roll. */
export function rollRarity(rates: GachaFile['rates'], rng: Rng, min = 1): number {
  const eligible = rates.filter((r) => r.rarity >= min && r.weight > 0);
  const total = eligible.reduce((sum, r) => sum + r.weight, 0);
  let x = rng() * total;
  for (const r of eligible) {
    x -= r.weight;
    if (x <= 0) return r.rarity;
  }
  const last = eligible[eligible.length - 1];
  if (!last) throw new Error(`No gacha rates at or above rarity ${min}`);
  return last.rarity;
}

export interface PullResult {
  dex: number;
  rarity: number;
  shiny: boolean;
  /** First time owning it (or its shiny, for a shiny). */
  isNew: boolean;
  /** Coins given for a duplicate (0 if new). */
  refund: number;
}

export interface PullInput {
  config: GachaFile;
  pool: BannerPool;
  count: number;
  /** Pulls on this banner since the last 5★. */
  pity: number;
  /** Owned dex numbers. Updated in place as the pulls grant Pokémon. */
  owned: Set<number>;
  /** Owned shiny dex numbers. Updated in place. */
  shiny: Set<number>;
  hasShiny: (dex: number) => boolean;
  rng: Rng;
}

export interface PullOutcome {
  results: PullResult[];
  /** The banner's pity after the pulls. */
  pity: number;
}

/**
 * Rolls `count` pulls (original `pull`):
 * - each pull adds 1 to the banner's pity and rolls at `ratesAt` that pity: soft pity raises the
 *   5★ chance from `softPity.from`, the `hardPity`-th pull is 5★, and a 5★ resets the pity;
 * - the last pull of a multi is at least `multiGuaranteeMinRarity` if no earlier one was, rolled
 *   at the same soft-pity rates restricted to those rarities;
 * - an empty rarity falls back to the nearest one (`poolNear`);
 * - `shinyRate` of pulls of Pokémon with shiny sprites are shiny. Shinies don't repeat: an owned
 *   shiny is swapped for one of the same rarity whose shiny is missing, or comes out normal;
 * - duplicates refund coins by rarity, ×`shinyDuplicateMultiplier` for shinies.
 */
export function rollPulls(input: PullInput): PullOutcome {
  const { config, pool, count, owned, shiny: ownedShiny, hasShiny, rng } = input;
  const refundOf = (rarity: number) =>
    config.duplicateRefund.find((r) => r.rarity === rarity)?.coins ?? 0;
  const isMulti = count === config.cost.multiCount;
  let pity = input.pity;
  const results: PullResult[] = [];

  for (let i = 0; i < count; i++) {
    pity += 1;
    const guaranteed =
      isMulti &&
      i === count - 1 &&
      !results.some((r) => r.rarity >= config.multiGuaranteeMinRarity);
    const want = rollRarity(
      ratesAt(config, pity),
      rng,
      guaranteed ? config.multiGuaranteeMinRarity : 1,
    );

    const { rarity, list } = poolNear(pool, want);
    if (rarity === 5) pity = 0;
    let mon = pick(list, rng);
    let shiny = hasShiny(mon.dex) && rng() < config.shinyRate;
    if (shiny && ownedShiny.has(mon.dex)) {
      const missing = list.filter((p) => hasShiny(p.dex) && !ownedShiny.has(p.dex));
      if (missing.length > 0) mon = pick(missing, rng);
      else shiny = false;
    }

    let isNew: boolean;
    let refund = 0;
    if (shiny) {
      isNew = !ownedShiny.has(mon.dex);
      if (isNew) ownedShiny.add(mon.dex);
      else refund = Math.round(refundOf(rarity) * config.shinyDuplicateMultiplier);
      owned.add(mon.dex);
    } else {
      isNew = !owned.has(mon.dex);
      if (isNew) owned.add(mon.dex);
      else refund = refundOf(rarity);
    }
    results.push({ dex: mon.dex, rarity, shiny, isNew, refund });
  }
  return { results, pity };
}
