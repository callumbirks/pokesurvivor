// The sim's only source of randomness: sfc32, seeded with splitmix32. Its whole state is four
// uint32s kept in `SimState.rng`, so a snapshot carries it and replays are exact.

export type RngState = [number, number, number, number];

export function seedRng(seed: number): RngState {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const out: RngState = [next(), next(), next(), next()];
  // Warm up so close seeds diverge.
  for (let i = 0; i < 12; i++) nextFloat(out);
  return out;
}

/** Uniform float in [0, 1). */
export function nextFloat(r: RngState): number {
  let [a, b, c, d] = r;
  a >>>= 0;
  b >>>= 0;
  c >>>= 0;
  d >>>= 0;
  const t = (((a + b) >>> 0) + d) >>> 0;
  d = (d + 1) >>> 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) >>> 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) >>> 0;
  r[0] = a;
  r[1] = b;
  r[2] = c;
  r[3] = d;
  return t / 4294967296;
}

/** Helpers bound to one RNG state. */
export interface Rand {
  (): number;
  /** Uniform in [a, b). */
  range(a: number, b: number): number;
  /** Integer in [a, b]. */
  int(a: number, b: number): number;
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  /** `n` distinct elements in random order. */
  pickN<T>(list: readonly T[], n: number): T[];
  /** Shuffles in place. */
  shuffle<T>(list: T[]): T[];
}

export function makeRand(r: RngState): Rand {
  const f = (() => nextFloat(r)) as Rand;
  f.range = (a, b) => a + nextFloat(r) * (b - a);
  f.int = (a, b) => Math.floor(a + nextFloat(r) * (b - a + 1));
  f.chance = (p) => nextFloat(r) < p;
  f.pick = <T>(list: readonly T[]): T => {
    if (list.length === 0) throw new Error('pick from an empty list');
    return list[Math.floor(nextFloat(r) * list.length)] as T;
  };
  f.pickN = <T>(list: readonly T[], n: number): T[] => {
    const pool = list.slice();
    const out: T[] = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(nextFloat(r) * pool.length), 1)[0] as T);
    }
    return out;
  };
  f.shuffle = <T>(list: T[]): T[] => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(nextFloat(r) * (i + 1));
      const tmp = list[i] as T;
      list[i] = list[j] as T;
      list[j] = tmp;
    }
    return list;
  };
  return f;
}
