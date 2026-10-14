// Manual CSV summary; all metrics retain their three-seed ranges.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { median } from './measure-rifts.js';
import type { WildTrial } from './measure-wilds.js';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Usage: wilds:summary results.jsonl[.gz] [...]');
const groups = new Map<string, WildTrial[]>();
const seen = new Set<string>();
for (const path of paths) {
  const bytes = readFileSync(path);
  const raw = (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
  for (const line of raw.trim().split('\n')) {
    const row = JSON.parse(line) as WildTrial;
    if (row.kind !== 'wild') continue;
    const key = [
      row.phase ?? 'before',
      row.minute,
      row.profile,
      row.meta,
      row.players,
      row.archetype,
    ].join(',');
    const unique = `${key},${row.seed}`;
    if (seen.has(unique)) throw new Error(`duplicate trial ${unique}`);
    seen.add(unique);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
}
const metrics = {
  maxHp: (r: WildTrial) => r.maxHp,
  reduction: (r: WildTrial) => r.reduction,
  effectiveHp: (r: WildTrial) => r.effectiveHp,
  contactPct: (r: WildTrial) => r.contactPct,
  shotPct: (r: WildTrial) => r.shotPct,
  skillPct: (r: WildTrial) => r.skillPct,
  elitePct: (r: WildTrial) => r.elitePct,
  bossPct: (r: WildTrial) => r.bossPct,
  contactHits: (r: WildTrial) => r.contactHits,
  shotHits: (r: WildTrial) => r.shotHits,
  worstContactPct: (r: WildTrial) => r.worstContactPct,
  worstShotPct: (r: WildTrial) => r.worstShotPct,
  timeFactor: (r: WildTrial) => r.timeFactor,
  rosterBase: (r: WildTrial) => r.rosterBase,
  regularHp: (r: WildTrial) => r.regularHp,
  teamDps: (r: WildTrial) => r.teamDps,
  regularTtk: (r: WildTrial) => r.regularTtk,
  stationaryDps: (r: WildTrial) => r.crowds?.stationary.dps ?? null,
  kiteDps: (r: WildTrial) => r.crowds?.kite.dps ?? null,
  firstDown: (r: WildTrial) => r.crowds?.survival.firstDown ?? null,
  kiteFirstDown: (r: WildTrial) => r.crowds?.survivalKite?.firstDown ?? null,
  crowdEnemies: (r: WildTrial) => r.crowds?.stationary.meanEnemies ?? null,
};
console.log(
  [
    'phase,minute,profile,meta,players,archetype,n,survivalCensored,kiteSurvivalCensored,contactOneShots,shotOneShots',
    ...Object.keys(metrics).flatMap((k) => [`${k}Median`, `${k}Min`, `${k}Max`]),
  ].join(','),
);
for (const [key, rows] of [...groups].sort(([a], [b]) =>
  a.localeCompare(b, 'en', { numeric: true }),
)) {
  console.log(
    [
      key,
      rows.length,
      rows.filter((r) => r.crowds?.survival.censored).length,
      rows.filter((r) => r.crowds?.survivalKite?.censored).length,
      rows.filter((r) => r.worstContactPct >= 100).length,
      rows.filter((r) => r.worstShotPct >= 100).length,
      ...Object.values(metrics).flatMap<string | number>((get) => {
        const xs = rows.map(get).filter((n): n is number => n !== null);
        return xs.length ? [median(xs), Math.min(...xs), Math.max(...xs)] : ['', '', ''];
      }),
    ].join(','),
  );
}
