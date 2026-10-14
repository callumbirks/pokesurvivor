// Manual curve fits: no balance assertions or CI test registration.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { legendHpMultiplier } from '../src/rift.js';
import { median, type DamageProbe } from './measure-rifts.js';
import type { TuningFile } from '@pokesurvivor/data';

const args = process.argv.slice(2);
const m0 = Number(args.find((a) => a.startsWith('--m0='))?.split('=')[1] ?? 4);
const targetSeconds = Number(args.find((a) => a.startsWith('--target='))?.split('=')[1] ?? 45);
if (!Number.isFinite(m0) || m0 < 0 || !Number.isFinite(targetSeconds) || targetSeconds <= 0)
  throw new Error('m0 must be nonnegative; target must be positive');
const objective = args.find((a) => a.startsWith('--objective='))?.split('=')[1] ?? 'log';
const smoothMax = Number(args.find((a) => a.startsWith('--smooth-max='))?.split('=')[1] ?? 1.6);
const maxSeconds = Number(args.find((a) => a.startsWith('--max-seconds='))?.split('=')[1] ?? 75);
if (!['log', 'gentle'].includes(objective)) throw new Error('objective must be log or gentle');
if (
  !Number.isFinite(smoothMax) ||
  smoothMax <= 1 ||
  !Number.isFinite(maxSeconds) ||
  maxSeconds <= 0
)
  throw new Error('smooth-max must exceed 1; max-seconds must be positive');
for (const arg of args.filter((a) => a.startsWith('--'))) {
  if (
    !['m0', 'target', 'objective', 'smooth-max', 'max-seconds'].includes(
      arg.slice(2).split('=')[0]!,
    )
  )
    throw new Error(`unknown argument ${arg}`);
}
const groups = new Map<string, number[]>();
const seen = new Set<string>();
for (const path of args.filter((a) => !a.startsWith('--'))) {
  const bytes = readFileSync(path);
  const raw = path.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  let curve: TuningFile['rift']['hpCurve'] | undefined;
  for (const line of raw.trim().split('\n')) {
    const row = JSON.parse(line) as
      | DamageProbe
      | {
          kind: 'metadata';
          riftTuning?: { hpCurve?: TuningFile['rift']['hpCurve'] };
        };
    if (row.kind === 'metadata') {
      curve = row.riftTuning?.hpCurve;
      continue;
    }
    if (row.kind !== 'probe' || row.meta !== 'max' || row.profile !== 'typical' || row.minute <= m0)
      continue;
    const key = `${row.minute}/${row.players}`;
    const identity = `${key}/${row.archetype}/${row.seed}`;
    if (seen.has(identity)) throw new Error(`duplicate probe ${identity}`);
    seen.add(identity);
    const baseHp = row.legendHp / (curve ? legendHpMultiplier(row.minute, curve) : 1);
    const ratios = groups.get(key) ?? [];
    ratios.push((row.fightDps * targetSeconds) / baseHp);
    groups.set(key, ratios);
  }
}
const points = [...groups]
  .map(([key, ratios]) => {
    const [minute, players] = key.split('/').map(Number);
    return { minute: minute!, players: players!, ratio: median(ratios), samples: ratios.length };
  })
  .sort((a, b) => a.minute - b.minute || a.players - b.players);
if (points.length < 2 || points.some((p) => !Number.isFinite(p.ratio) || p.ratio <= 0))
  throw new Error('need at least two max-meta typical probe groups with positive delivered DPS');
// Equal weight per minute/team median. Log fitting is retained to reproduce the first
// experiment. Gentle fitting penalizes >60 s much more than <30 s and caps every reference
// duration, while limiting the first minute's uplift and keeping p >= 1 for a steady ramp.
let best = { a: 0, p: 0, loss: Infinity };
let rounded: TuningFile['rift']['hpCurve'];
const score = (a: number, p: number) =>
  points.reduce((sum, point) => {
    const e = p * Math.log1p(a * (point.minute - m0)) - Math.log(point.ratio);
    return (
      sum +
      e * e +
      0.5 * Math.max(0, Math.log(30 / targetSeconds) - e) ** 2 +
      8 * Math.max(0, e - Math.log(60 / targetSeconds)) ** 2
    );
  }, 0);
const feasible = (a: number, p: number) =>
  p >= 1 &&
  a > 0 &&
  (1 + a) ** p <= smoothMax &&
  points.every(
    (point) =>
      (targetSeconds * legendHpMultiplier(point.minute, { m0, a, p })) / point.ratio <= maxSeconds,
  );
if (objective === 'log') {
  for (let i = 0; i <= 12000; i++) {
    const a = 10 ** (-3 + i / 2000);
    const xs = points.map((point) => Math.log1p(a * (point.minute - m0)));
    const ys = points.map((point) => Math.log(point.ratio));
    const p = xs.reduce((sum, x, j) => sum + x * ys[j]!, 0) / xs.reduce((sum, x) => sum + x * x, 0);
    const loss = xs.reduce((sum, x, j) => sum + (p * x - ys[j]!) ** 2, 0);
    if (p > 0 && loss < best.loss) best = { a, p, loss };
  }
  rounded = { m0, a: Math.round(best.a * 10) / 10, p: Math.round(best.p * 100) / 100 };
} else {
  for (let i = 0; i <= 10000; i++) {
    const a = 10 ** (-3 + (i / 10000) * Math.log10(4500));
    const xs = points.map((point) => Math.log1p(a * (point.minute - m0)));
    let lo = 1;
    let hi = Math.min(
      Math.log(smoothMax) / Math.log1p(a),
      ...points.map((point, j) => Math.log((maxSeconds * point.ratio) / targetSeconds) / xs[j]!),
    );
    if (hi < lo) continue;
    // The piecewise-quadratic log loss is convex in p: bisect its derivative.
    for (let j = 0; j < 40; j++) {
      const p = (lo + hi) / 2;
      const derivative = points.reduce((sum, point, k) => {
        const x = xs[k]!;
        const e = p * x - Math.log(point.ratio);
        return (
          sum +
          x *
            (e -
              0.5 * Math.max(0, Math.log(30 / targetSeconds) - e) +
              8 * Math.max(0, e - Math.log(60 / targetSeconds)))
        );
      }, 0);
      if (derivative > 0) hi = p;
      else lo = p;
    }
    const p = (lo + hi) / 2;
    const loss = score(a, p);
    if (loss < best.loss) best = { a, p, loss };
  }
  if (!Number.isFinite(best.loss))
    throw new Error('no feasible curve for the requested constraints');
  // Round near the optimum to three decimals, checking constraints again after rounding.
  const candidates = [Math.floor(best.a * 1000), Math.ceil(best.a * 1000)].flatMap((a) =>
    [Math.floor(best.p * 1000), Math.ceil(best.p * 1000)].map((p) => ({
      m0,
      a: a / 1000,
      p: p / 1000,
    })),
  );
  const picked = candidates
    .filter((c) => feasible(c.a, c.p))
    .sort((a, b) => score(a.a, a.p) - score(b.a, b.p))[0];
  if (!picked) throw new Error('no feasible rounded curve; inspect the unrounded fit');
  rounded = picked;
}
console.log(
  JSON.stringify(
    {
      targetSeconds,
      objective,
      constraints:
        objective === 'gentle'
          ? { firstMinuteMax: smoothMax, referenceSecondsMax: maxSeconds, minimumExponent: 1 }
          : undefined,
      fit: { m0, ...best },
      rounded,
      points: points.map((point) => ({
        ...point,
        fittedMultiplier: legendHpMultiplier(point.minute, rounded),
        damageEquivalentSeconds:
          (targetSeconds * legendHpMultiplier(point.minute, rounded)) / point.ratio,
      })),
    },
    null,
    2,
  ),
);
