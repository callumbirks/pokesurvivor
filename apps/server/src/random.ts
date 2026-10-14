import { randomInt } from 'node:crypto';

/** A source of uniform numbers in `[0, 1)`. Injected so tests can use a seeded one. */
export type Rng = () => number;

const CRYPTO_RANGE = 2 ** 48 - 1;

/** Cryptographically secure randomness, for anything that pays out (gacha, rerolls). */
export const cryptoRng: Rng = () => randomInt(CRYPTO_RANGE) / CRYPTO_RANGE;

/**
 * A deterministic generator seeded from a string: FNV-1a hash of the seed, then a
 * mulberry32-style step. Ported unchanged from original `progress.js` `rng()`, which rolls the
 * missions, so the same seed gives the same sequence.
 */
export function seededRng(seed: string): Rng {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly random element (original `G.U.pick`). */
export function pick<T>(list: readonly T[], rng: Rng): T {
  const item = list[Math.floor(rng() * list.length)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
}
