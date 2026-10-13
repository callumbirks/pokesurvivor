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

/**
 * 0.3 rolls a 1★ (30 of 100 weight falls in the 45.9 of 1★) until soft pity has taken 35% for the
 * 5★, a non-shiny, and the 30% pick.
 */
const COMMON = constant(0.3);
/** 0 rolls a 1★ (or the lowest allowed rarity) until hard pity, and the first Pokémon. */
const LOWEST = constant(0);

function pulls(over: Partial<PullInput> = {}) {
  return rollPulls({
    config,
    pool: kanto,
    count: 1,
    pity: 0,
    owned: new Set(),
    shiny: new Set(),
    hasShiny: data.hasShinySprite,
    rng: COMMON,
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
    expect(featured).toContain(150); // Mewtwo
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
  it('adds 6 points of 5★ chance per pull from the 74th, and is certain at the 90th', () => {
    expect(config.softPity).toEqual({ from: 74, stepPerPull: 0.06 });
    expect(config.hardPity).toBe(90);
    expect(fiveStarChance(config, 1)).toBeCloseTo(0.006);
    expect(fiveStarChance(config, 73)).toBeCloseTo(0.006);
    expect(fiveStarChance(config, 74)).toBeCloseTo(0.066);
    expect(fiveStarChance(config, 75)).toBeCloseTo(0.126);
    expect(fiveStarChance(config, 89)).toBeCloseTo(0.966);
    expect(fiveStarChance(config, 90)).toBe(1);
  });

  it('takes the extra 5★ chance from the other rarities in proportion', () => {
    for (const pity of [1, 74, 80, 89, 90]) {
      const rates = ratesAt(config, pity);
      expect(rates.reduce((sum, r) => sum + r.weight, 0)).toBeCloseTo(1);
      expect(rates.find((r) => r.rarity === 5)!.weight).toBeCloseTo(fiveStarChance(config, pity));
      // 1★ : 2★ stays 45.9 : 30.
      const [one, two] = rates;
      if (pity < 90) expect(one!.weight / two!.weight).toBeCloseTo(45.9 / 30);
      else expect(one!.weight).toBe(0);
    }
    // Before soft pity, the gacha.json weights (which total 100).
    ratesAt(config, 1).forEach((r, i) =>
      expect(r.weight * 100).toBeCloseTo(config.rates[i]!.weight),
    );
  });

  it('rolls 5★ at the soft-pity chance', () => {
    const rng = seededRng('soft-pity');
    const n = 100_000;
    for (const pity of [74, 80]) {
      const rates = ratesAt(config, pity);
      let fives = 0;
      for (let i = 0; i < n; i++) if (rollRarity(rates, rng) === 5) fives += 1;
      const expected = fiveStarChance(config, pity);
      const sd = Math.sqrt((expected * (1 - expected)) / n);
      expect(Math.abs(fives / n - expected)).toBeLessThan(5 * sd);
    }
  });
});

describe('rollPulls', () => {
  it('gives a 5★ on the 90th pull without one, then resets the pity', () => {
    let pity = 0;
    const rarities: number[] = [];
    for (let i = 0; i < config.hardPity; i++) {
      const out = pulls({ pity, rng: LOWEST });
      pity = out.pity;
      rarities.push(out.results[0]!.rarity);
    }
    expect(rarities.slice(0, 89).every((r) => r === 1)).toBe(true);
    expect(rarities[89]).toBe(5);
    expect(pity).toBe(0);
  });

  it('ramps the 5★ chance with soft pity', () => {
    // 0.9 is the top 10%: a 3★ at the base rates, a 4★ at the 74th pull (6.6% 5★) and a 5★ at
    // the 75th (12.6%).
    const rng = constant(0.9);
    const rarities: number[] = [];
    let pity = 72;
    for (let i = 0; i < 4; i++) {
      const out = pulls({ pity, rng });
      pity = out.pity;
      rarities.push(out.results[0]!.rarity);
    }
    expect(rarities).toEqual([3, 4, 5, 3]);
    expect(pity).toBe(1);
  });

  it('counts pity inside a ×10 and skips the guarantee once a 5★ came out', () => {
    const out = pulls({ count: 10, pity: 88, rng: LOWEST });
    expect(out.results.map((r) => r.rarity)).toEqual([1, 5, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(out.pity).toBe(8);
  });

  it('guarantees a 4★ or better on the last pull of a ×10', () => {
    const out = pulls({ count: 10 });
    expect(out.results.map((r) => r.rarity)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 4]);
    expect(out.pity).toBe(10);
    // A single pull gets no guarantee.
    expect(pulls({ count: 1 }).results[0]!.rarity).toBe(1);
  });

  it('rolls the ×10 guarantee at the soft-pity rates', () => {
    // Pulls 69–77 stay 1★ at 0.3. The guarantee on the 78th rolls 4★ (4.5%) vs 5★ (30.6%): 0.3 of
    // the way is a 5★, where at the base rates (6.5 vs 0.6) it would be a 4★.
    const out = pulls({ count: 10, pity: 68 });
    expect(out.results.map((r) => r.rarity)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 5]);
    expect(out.pity).toBe(0);
  });

  it('gives the hard-pity 5★ on the guaranteed pull of a ×10', () => {
    const out = pulls({ count: 10, pity: 80, rng: LOWEST });
    expect(out.results.map((r) => r.rarity)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 5]);
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
    // 0.001: 1★, the first Pokémon of the pool, and shiny (0.001 < 1%).
    const rng = constant(0.001);
    const commons = kanto.byRarity.get(1)!.filter((p) => data.hasShinySprite(p.dex));
    const [first, second] = commons;
    expect(first).toBe(kanto.byRarity.get(1)![0]);
    const fresh = pulls({ rng });
    expect(fresh.results[0]).toMatchObject({ dex: first!.dex, shiny: true, isNew: true });

    const shiny = new Set([first!.dex]);
    const owned = new Set([first!.dex]);
    const repicked = pulls({ rng, shiny, owned });
    expect(repicked.results[0]).toMatchObject({ dex: second!.dex, shiny: true, isNew: true });
    expect(shiny.has(second!.dex) && owned.has(second!.dex)).toBe(true);

    const allShiny = new Set(commons.map((p) => p.dex));
    const normal = pulls({ rng, shiny: allShiny, owned: new Set(allShiny) });
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
      expect(Math.abs(actual - expected)).toBeLessThan(5 * sd);
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
      const out = pulls({ count, pity, rng, owned, shiny });
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

  it('gives a 5★ about every 62 single pulls, never more than 90 apart', () => {
    const { rate, maxGap, shinies } = simulate(1, 400_000, 'pity');
    expect(maxGap).toBeLessThanOrEqual(config.hardPity);
    // 0.6% base, raised by soft and hard pity to one per ≈62.3 pulls (1.605%); measured 1.60%.
    expect(1 / rate).toBeGreaterThan(60);
    expect(1 / rate).toBeLessThan(65);
    // Shinies stop once the pool's shinies are all owned, so only check they happen.
    expect(shinies).toBeGreaterThan(0);
  });

  it('gives a 5★ about every 55 pulls in ×10s, with the guarantee’s 5★ share', () => {
    const { rate, maxGap } = simulate(10, 400_000, 'pity-multi');
    expect(maxGap).toBeLessThanOrEqual(config.hardPity);
    // Measured 1.80%: the ×10 guarantee is a 5★ about 8% of the time it applies.
    expect(1 / rate).toBeGreaterThan(52);
    expect(1 / rate).toBeLessThan(58);
  });
});
