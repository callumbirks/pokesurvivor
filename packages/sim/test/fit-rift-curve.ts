// Manual log-space fit: no balance assertions or CI test registration.
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
// Equal weight per minute/team median. Search a logarithmically over [0.001, 1000]; at each
// a solve the least-squares exponent analytically: p = sum(x*y) / sum(x*x).
let best = { a: 0, p: 0, squaredLogError: Infinity };
for (let i = 0; i <= 12000; i++) {
  const a = 10 ** (-3 + i / 2000);
  const xs = points.map((point) => Math.log1p(a * (point.minute - m0)));
  const ys = points.map((point) => Math.log(point.ratio));
  const p = xs.reduce((sum, x, j) => sum + x * ys[j]!, 0) / xs.reduce((sum, x) => sum + x * x, 0);
  const squaredLogError = xs.reduce((sum, x, j) => sum + (p * x - ys[j]!) ** 2, 0);
  if (p > 0 && squaredLogError < best.squaredLogError) best = { a, p, squaredLogError };
}
const rounded = { m0, a: Math.round(best.a * 10) / 10, p: Math.round(best.p * 100) / 100 };
console.log(
  JSON.stringify(
    {
      targetSeconds,
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
