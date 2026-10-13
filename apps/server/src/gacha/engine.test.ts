import { describe, expect, it } from 'vitest';
import { getServerData } from '../data.js';
import { seededRng } from '../random.js';
import type { Rng } from '../random.js';
import { featuredOf, poolNear, rollPulls, rollRarity } from './engine.js';
import type { BannerPool, PullInput } from './engine.js';
import { bannerPools } from './service.js';

const data = getServerData();
const config = data.gacha;
const kanto = bannerPools().get('kanto')!;
const constant =
  (x: number): Rng =>
  () =>
    x;

/** 0.3 rolls a 1★ (30 of 100 weight falls in the 45 of 1★), a non-shiny, and the 30% pick. */
const COMMON = constant(0.3);

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

describe('rollPulls', () => {
  it('gives a 5★ on the 70th pull without one, then resets the pity', () => {
    let pity = 0;
    const rarities: number[] = [];
    for (let i = 0; i < config.hardPity; i++) {
      const out = pulls({ pity });
      pity = out.pity;
      rarities.push(out.results[0]!.rarity);
    }
    expect(config.hardPity).toBe(70);
    expect(rarities.slice(0, 69).every((r) => r === 1)).toBe(true);
    expect(rarities[69]).toBe(5);
    expect(pity).toBe(0);
  });

  it('counts pity inside a ×10 and skips the guarantee once a 5★ came out', () => {
    const out = pulls({ count: 10, pity: 68 });
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

  it('never goes 70 pulls without a 5★ and lands near the expected 5★ rate', () => {
    const rng = seededRng('pity');
    const owned = new Set<number>();
    const shiny = new Set<number>();
    let pity = 0;
    let sinceFive = 0;
    let maxGap = 0;
    let fives = 0;
    let shinies = 0;
    const n = 50_000;
    for (let i = 0; i < n / 10; i++) {
      const out = pulls({ count: 10, pity, rng, owned, shiny });
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
    expect(maxGap).toBeLessThanOrEqual(config.hardPity);
    // 1.5% base, raised by the hard pity (≈2.3%) and the ×10 guarantee's 5★ share.
    expect(fives / n).toBeGreaterThan(0.015);
    expect(fives / n).toBeLessThan(0.035);
    // Shinies stop once the pool's shinies are all owned, so only check they happen.
    expect(shinies).toBeGreaterThan(0);
  });
});
