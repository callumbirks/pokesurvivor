import { describe, expect, it } from 'vitest';
import { getServerData } from '../data.js';
import { seededRng } from '../random.js';
import type { Rng } from '../random.js';
import { featuredOf, fiveStarChance, poolNear, ratesAt, rollPulls, rollRarity } from './engine.js';
import type { BannerPool, PullInput } from './engine.js';
import { bannerPools } from './service.js';

const data = getServerData();
const config = data.gacha;
const kanto = bannerPools().get('kanto')!;
const constant =
  (x: number): Rng =>
  () =>
    x;

/** Zero selects the lowest positive-weight rarity and the first Pokémon in its pool. */
const LOWEST = constant(0);
// Isolate hard pity even if the shipped soft ramp reaches certainty earlier.
const hardOnly = { ...config, softPity: { ...config.softPity, stepPerPull: 0 } };

function pulls(over: Partial<PullInput> = {}) {
  return rollPulls({
    config,
    pool: kanto,
    count: 1,
    pity: 0,
    owned: new Set(),
    shiny: new Set(),
    hasShiny: () => false,
    rng: LOWEST,
    ...over,
  });
}

describe('banner pools', () => {
  it('holds the generation’s Pokémon that have sprites, by rarity', () => {
    expect(kanto.all.every((p) => p.gen === 1 && data.hasSprite(p.dex))).toBe(true);
    for (const rarity of [1, 2, 3, 4, 5])
      expect(kanto.byRarity.get(rarity)?.length).toBeGreaterThan(0);
    expect(bannerPools().size).toBe(config.banners.length);
  });

  it('features the three strongest 5★', () => {
    const featured = featuredOf(kanto);
    expect(featured).toHaveLength(3);
    expect(featured).toEqual(
      [...kanto.byRarity.get(5)!]
        .sort((a, b) => b.bst - a.bst)
        .slice(0, 3)
        .map((p) => p.dex),
    );
  });

  it('falls back to the nearest non-empty rarity', () => {
    const pool: BannerPool = {
      id: 'test',
      gen: 1,
      all: kanto.all,
      byRarity: new Map([
        [1, kanto.byRarity.get(1)!],
        [3, kanto.byRarity.get(3)!],
      ]),
    };
    expect(poolNear(pool, 1).rarity).toBe(1);
    expect(poolNear(pool, 2).rarity).toBe(1); // -1 is tried before +1
    expect(poolNear(pool, 5).rarity).toBe(3);
    const empty: BannerPool = { ...pool, byRarity: new Map() };
    expect(poolNear(empty, 4)).toEqual({ rarity: 4, list: kanto.all });
  });
});

describe('soft pity', () => {
  it('uses the configured base rate, soft-pity start and step, then guarantees hard pity', () => {
    const total = config.rates.reduce((sum, r) => sum + r.weight, 0);
    const base = config.rates.find((r) => r.rarity === 5)!.weight / total;
    const from = config.softPity.from;
    expect(fiveStarChance(config, from - 1)).toBeCloseTo(base);
    for (const pull of [from, from + 1, config.hardPity - 1]) {
      const expected = Math.min(
        1,
        base + Math.max(0, pull - from + 1) * config.softPity.stepPerPull,
      );
      expect(fiveStarChance(config, pull)).toBeCloseTo(expected);
    }
    expect(fiveStarChance(config, config.hardPity)).toBe(1);
    expect(fiveStarChance(config, config.hardPity + 1)).toBe(1);
  });

  it('takes the extra 5★ chance from the other rarities in proportion', () => {
    for (const pity of [
      1,
      config.softPity.from,
      config.softPity.from + 1,
      config.hardPity - 1,
      config.hardPity,
    ]) {
      const rates = ratesAt(config, pity);
      expect(rates.reduce((sum, r) => sum + r.weight, 0)).toBeCloseTo(1);
      expect(rates.find((r) => r.rarity === 5)!.weight).toBeCloseTo(fiveStarChance(config, pity));
      // The relative weights of the lower rarities stay unchanged.
      const [one, two] = rates;
      if (fiveStarChance(config, pity) < 1)
        expect(one!.weight / two!.weight).toBeCloseTo(
          config.rates[0]!.weight / config.rates[1]!.weight,
        );
      else expect(one!.weight).toBe(0);
    }
    // Before soft pity, the weights are normalized by their configured total.
    const total = config.rates.reduce((sum, r) => sum + r.weight, 0);
    ratesAt(config, 1).forEach((r, i) =>
      expect(r.weight * total).toBeCloseTo(config.rates[i]!.weight),
    );
  });

  it('rolls 5★ at the soft-pity chance', () => {
    const rng = seededRng('soft-pity');
    const n = 100_000;
    for (const pity of [config.softPity.from, config.softPity.from + 1]) {
      const rates = ratesAt(config, pity);
      let fives = 0;
      for (let i = 0; i < n; i++) if (rollRarity(rates, rng) === 5) fives += 1;
      const expected = fiveStarChance(config, pity);
      const sd = Math.sqrt((expected * (1 - expected)) / n);
      expect(Math.abs(fives / n - expected)).toBeLessThanOrEqual(5 * sd + 1 / n);
    }
  });
});

describe('rollPulls', () => {
  it('gives a 5★ at configured hard pity and resets it', () => {
    let pity = 0;
    const rarities: number[] = [];
    for (let i = 0; i < config.hardPity; i++) {
      const out = pulls({ config: hardOnly, pity, rng: LOWEST });
      pity = out.pity;
      rarities.push(out.results[0]!.rarity);
    }
    expect(rarities.slice(0, config.hardPity - 1).every((r) => r === 1)).toBe(true);
    expect(rarities[config.hardPity - 1]).toBe(5);
    expect(pity).toBe(0);
  });

  it('ramps the 5★ chance with soft pity', () => {
    const before = config.softPity.from - 1;
    const base = fiveStarChance(config, before);
    const raised = fiveStarChance(config, before + 1);
    const rng = constant(1 - (base + raised) / 2);
    const first = pulls({ pity: before - 1, rng });
    expect(first.results[0]!.rarity).toBeLessThan(5);
    expect(first.pity).toBe(before);
    const second = pulls({ pity: first.pity, rng });
    expect(second.results[0]!.rarity).toBe(5);
    expect(second.pity).toBe(0);
  });

  it('counts pity inside a ×10 and skips the guarantee once a 5★ came out', () => {
    const out = pulls({
      config: hardOnly,
      count: config.cost.multiCount,
      pity: config.hardPity - 2,
      rng: LOWEST,
    });
    expect(out.results.map((r) => r.rarity)).toEqual([
      1,
      5,
      ...Array<number>(config.cost.multiCount - 2).fill(1),
    ]);
    expect(out.pity).toBe(config.cost.multiCount - 2);
  });

  it('guarantees a 4★ or better on the last pull of a ×10', () => {
    const out = pulls({ count: config.cost.multiCount });
    expect(out.results.map((r) => r.rarity)).toEqual([
      ...Array<number>(config.cost.multiCount - 1).fill(1),
      config.multiGuaranteeMinRarity,
    ]);
    expect(out.pity).toBe(config.cost.multiCount);
    // A single pull gets no guarantee.
    expect(pulls({ count: 1 }).results[0]!.rarity).toBe(1);
  });

  it('rolls the ×10 guarantee at the soft-pity rates', () => {
    const count = config.cost.multiCount;
    const last = config.softPity.from;
    const rates = ratesAt(config, last).filter((r) => r.rarity >= config.multiGuaranteeMinRarity);
    const five = rates.find((r) => r.rarity === 5)!.weight;
    const total = rates.reduce((sum, r) => sum + r.weight, 0);
    // Choose a draw inside the boosted guarantee's 5★ interval; other draws stay lowest.
    const baseRates = ratesAt(config, last - 1).filter(
      (r) => r.rarity >= config.multiGuaranteeMinRarity,
    );
    const baseTotal = baseRates.reduce((sum, r) => sum + r.weight, 0);
    const baseShare = baseRates.find((r) => r.rarity === 5)!.weight / baseTotal;
    const guaranteedDraw = 1 - (five / total + baseShare) / 2;
    let draws = 0;
    const out = pulls({
      count,
      pity: last - count,
      rng: () => (++draws === (count - 1) * 2 + 1 ? guaranteedDraw : 0),
    });
    expect(out.results.map((r) => r.rarity)).toEqual([...Array<number>(count - 1).fill(1), 5]);
    expect(out.pity).toBe(0);
  });

  it('gives the hard-pity 5★ on the guaranteed pull of a ×10', () => {
    const out = pulls({
      config: hardOnly,
      count: config.cost.multiCount,
      pity: config.hardPity - config.cost.multiCount,
      rng: LOWEST,
    });
    expect(out.results.map((r) => r.rarity)).toEqual([
      ...Array<number>(config.cost.multiCount - 1).fill(1),
      5,
    ]);
    expect(out.pity).toBe(0);
  });

  it('marks duplicates and refunds them by rarity', () => {
    const owned = new Set<number>();
    const first = pulls({ owned });
    const second = pulls({ owned });
    expect(first.results[0]).toMatchObject({ isNew: true, refund: 0, shiny: false });
    expect(second.results[0]).toMatchObject({
      dex: first.results[0]!.dex,
      isNew: false,
      refund: config.duplicateRefund.find((r) => r.rarity === 1)!.coins,
    });
  });

  it('re-picks an owned shiny for a missing one of the same rarity, else gives the normal form', () => {
    // Zero chooses the first common and falls below any positive shiny rate.
    const rng = LOWEST;
    const shinyPulls = (over: Partial<PullInput>) =>
      pulls({ hasShiny: data.hasShinySprite, ...over });
    const commons = kanto.byRarity.get(1)!.filter((p) => data.hasShinySprite(p.dex));
    const [first, second] = commons;
    expect(first).toBe(kanto.byRarity.get(1)![0]);
    const fresh = shinyPulls({ rng });
    expect(fresh.results[0]).toMatchObject({ dex: first!.dex, shiny: true, isNew: true });

    const shiny = new Set([first!.dex]);
    const owned = new Set([first!.dex]);
    const repicked = shinyPulls({ rng, shiny, owned });
    expect(repicked.results[0]).toMatchObject({ dex: second!.dex, shiny: true, isNew: true });
    expect(shiny.has(second!.dex) && owned.has(second!.dex)).toBe(true);

    const allShiny = new Set(commons.map((p) => p.dex));
    const normal = shinyPulls({ rng, shiny: allShiny, owned: new Set(allShiny) });
    expect(normal.results[0]).toMatchObject({
      dex: first!.dex,
      shiny: false,
      isNew: false,
      refund: config.duplicateRefund.find((r) => r.rarity === 1)!.coins,
    });
  });

  it('rolls rarities at the gacha.json rates', () => {
    const rng = seededRng('distribution');
    const n = 200_000;
    const counts = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const r = rollRarity(config.rates, rng);
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const total = config.rates.reduce((s, r) => s + r.weight, 0);
    for (const { rarity, weight } of config.rates) {
      const expected = weight / total;
      const actual = (counts.get(rarity) ?? 0) / n;
      // Within 5 standard deviations.
      const sd = Math.sqrt((expected * (1 - expected)) / n);
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(5 * sd + 1 / n);
    }
  });

  /** Pulls `n` times in `count`s from no pity; the 5★ rate, the longest gap and the shinies. */
  function simulate(count: number, n: number, seed: string) {
    const rng = seededRng(seed);
    const owned = new Set<number>();
    const shiny = new Set<number>();
    let pity = 0;
    let sinceFive = 0;
    let maxGap = 0;
    let fives = 0;
    let shinies = 0;
    for (let i = 0; i < n / count; i++) {
      const out = pulls({ count, pity, rng, owned, shiny, hasShiny: data.hasShinySprite });
      if (count === config.cost.multiCount)
        expect(out.results.some((r) => r.rarity >= config.multiGuaranteeMinRarity)).toBe(true);
      pity = out.pity;
      for (const r of out.results) {
        sinceFive += 1;
        if (r.shiny) shinies += 1;
        if (r.rarity === 5) {
          fives += 1;
          maxGap = Math.max(maxGap, sinceFive);
          sinceFive = 0;
        }
      }
    }
    return { rate: fives / n, maxGap, shinies };
  }

  it('single-pull frequency follows the configured pity distribution and bounds the gap', () => {
    const { rate, maxGap, shinies } = simulate(1, 100_000, 'pity');
    expect(maxGap).toBeLessThanOrEqual(config.hardPity);
    // Expected wait = sum of the probability of surviving each pull without a 5★.
    let survival = 1;
    let expectedWait = 0;
    for (let pull = 1; pull <= config.hardPity; pull++) {
      expectedWait += survival;
      survival *= 1 - fiveStarChance(config, pull);
    }
    expect(Math.abs(rate * expectedWait - 1)).toBeLessThan(0.05);
    expect(shinies).toBeGreaterThan(0);
  });

  it('multi-pulls keep the configured guarantee and never exceed the hard-pity gap', () => {
    const count = config.cost.multiCount;
    const { maxGap } = simulate(count, count * 5000, 'pity-multi');
    expect(maxGap).toBeLessThanOrEqual(config.hardPity);
  });
});
