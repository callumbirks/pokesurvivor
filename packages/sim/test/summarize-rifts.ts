// Manual CSV summary of one or more measure-rifts.ts JSONL files.
import { readFileSync } from 'node:fs';
import { median, type Trial } from './measure-rifts.js';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Usage: tsx test/summarize-rifts.ts results.jsonl [...]');
const groups = new Map<string, Trial[]>();
const seen = new Set<string>();
for (const path of paths) {
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    const row = JSON.parse(line) as { kind: string };
    if (row.kind !== 'trial') continue;
    const trial = row as Trial;
    const key = [
      trial.minute,
      trial.profile,
      trial.meta,
      trial.players,
      trial.archetype,
      trial.calibrationProtected ? 'protected' : 'ordinary',
    ].join(',');
    const trialKey = `${key},${trial.seed}`;
    if (seen.has(trialKey)) throw new Error(`duplicate trial ${trialKey}`);
    seen.add(trialKey);
    const group = groups.get(key) ?? [];
    group.push(trial);
    groups.set(key, group);
  }
}
console.log(
  'minute,profile,meta,players,archetype,calibration,n,wins,winRate,ttkWinsMedian,ttkWinsMin,ttkWinsMax,cappedTtkMedian,cappedTtkMin,cappedTtkMax,damageTakenMedian,damageTakenMin,damageTakenMax,downsMedian,downsMax,legendHpMedian,legendHpMin,legendHpMax,dummyDpsMedian,dummyDpsMin,dummyDpsMax,fightDpsMedian',
);
for (const [key, trials] of [...groups].sort(([a], [b]) =>
  a.localeCompare(b, 'en', { numeric: true }),
)) {
  const wins = trials.filter((r) => r.won).map((r) => r.ttk!);
  // Losses have no observed kill time. A 120-second capped score makes mixed cells visible;
  // it is not a measured TTK, and must never be interpreted as a kill at the deadline.
  const capped = trials.map((r) => r.ttk ?? 120);
  const stats = (xs: number[]) =>
    xs.length ? [median(xs), Math.min(...xs), Math.max(...xs)] : ['', '', ''];
  console.log(
    [
      key,
      trials.length,
      wins.length,
      wins.length / trials.length,
      ...stats(wins),
      ...stats(capped),
      ...stats(trials.map((r) => r.damageTaken)),
      median(trials.map((r) => r.downs)),
      Math.max(...trials.map((r) => r.downs)),
      ...stats(trials.map((r) => r.legendHp)),
      ...stats(trials.map((r) => r.dummyDps)),
      median(trials.map((r) => r.fightDps)),
    ].join(','),
  );
}
