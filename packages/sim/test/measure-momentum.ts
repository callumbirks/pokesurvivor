// Manual R8 step 3 check of Momentum and the guaranteed offence card. Never runs in CI.
//   pnpm --filter @pokesurvivor/sim momentum --variant=after --out=after.jsonl
//   pnpm --filter @pokesurvivor/sim momentum --variant=before --out=before.jsonl
//   (--max-stacks-start=30: Momentum with v12's flat cap)
// `before` turns both mechanics off (momentum.perStack 0, no guaranteed slots) for the whole
// run, so its builds are earned without them. Per cell, a protected natural run (first-choice
// bots) is checkpointed at each minute; each checkpoint's build then fights a real 60 s wild
// crowd twice (kiting bots, and a bot that stands and fights) and, in co-op from minute 20, a
// protected 120 s rift legend, entered with the stacks the kiting crowd ended on.
import { appendFileSync, writeFileSync } from 'node:fs';
import { DT } from '../src/constants.js';
import { simData } from '../src/data.js';
import { momentumCap } from '../src/momentum.js';
import type { PlayerState, Sim } from '../src/index.js';
import { botInputs } from './bots.js';
import { patchTuning, postponeAmbientSystems } from './helpers.js';
import {
  encounter,
  loadBuild,
  makeSim,
  naturalRun,
  type Cell,
  type Snapshot,
} from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
const list = (key: string, fallback: string) => (args.get(key) ?? fallback).split(',');
const variant = args.get('variant') ?? 'after';
if (!['before', 'after'].includes(variant)) throw new Error('--variant=before|after');
const minutes = list('minutes', '15,20,25,30,35').map(Number);
const seeds = list('seeds', '7,99').map(Number);
const players = list('players', '3,4').map(Number);
const metas = list('meta', 'half,max') as Cell['meta'][];
const archetypes = list('archetypes', 'projectile,melee,area') as Cell['archetype'][];
const out = args.get('out');
if (out) writeFileSync(out, '');
const emit = (row: unknown) => {
  const line = JSON.stringify(row) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};

// Every sim shares the loaded data: switch the mechanics off at the source for `before`.
const tuning = simData().game.tuning;
if (variant === 'before') {
  (tuning.momentum as { perStack: number }).perStack = 0;
  (tuning.lateGrowth.offers as { guaranteedOffenseSlots: number }).guaranteedOffenseSlots = 0;
}
// --max-stacks-start=N: compare another starting cap (e.g. the flat cap: N = maxStacks).
if (args.has('max-stacks-start'))
  (tuning.momentum as { maxStacksStart: number }).maxStacksStart = Number(
    args.get('max-stacks-start'),
  );
const momentumOn = tuning.momentum.perStack > 0;
emit({ kind: 'metadata', variant, minutes, seeds, players, metas, archetypes, tuning });

const OFFENSE = new Set(tuning.lateGrowth.offers.statIds);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

/** Stacks a player would have: what the sim tracks, even with the bonus switched off. */
const stacksOf = (p: PlayerState) => p.momentum;

/** A real crowd for 15 s warmup + 60 s, protected. `stand`: nobody moves (fights the horde). */
function crowd(sim: Sim, minute: number, stand: boolean) {
  sim.state.config.noSpawns = false;
  sim.state.config.invulnerable = true;
  let kills = 0;
  const samples: number[] = [];
  let enemies = 0;
  for (let tick = -Math.round(15 / DT); tick < 60 / DT; tick++) {
    sim.state.time = minute * 60;
    sim.state.pendingChoices = [];
    sim.state.pendingLevels = 0;
    sim.state.team.xp = 0;
    sim.state.team.xpNext = 1e12;
    if (stand) for (const p of sim.state.players) sim.setInput(p.id, { moveX: 0, moveY: 0 });
    else botInputs(sim);
    sim.step();
    sim.drainEvents();
    if (tick === -1) kills = -sim.state.team.kills;
    if (tick >= 0) {
      enemies += sim.state.enemies.length;
      if (tick % 15 === 0) for (const p of sim.state.players) samples.push(stacksOf(p));
    }
  }
  kills += sim.state.team.kills;
  return {
    killsPerSecond: kills / 60,
    meanEnemies: enemies / (60 / DT),
    stacksMean: mean(samples),
    stacksMedian: quantile(samples, 0.5),
    stacksP90: quantile(samples, 0.9),
    atCap:
      samples.filter((s) => s >= momentumCap(tuning.momentum, minute * 60) - 0.5).length /
      samples.length,
    meanMultiplier: mean(samples.map((s) => 1 + tuning.momentum.perStack * s)),
    endStacks: sim.state.players.map(stacksOf),
  };
}

function fromCheckpoint(cell: Cell, seed: number, snap: Snapshot) {
  const sim = makeSim(cell, seed, true, true);
  postponeAmbientSystems(sim, 1e6);
  sim.state.spawner.bossIndex = sim.state.roster.bosses.length;
  sim.state.weather.current = null;
  sim.state.time = snap.minute * 60;
  sim.state.team.level = snap.level;
  sim.state.players.forEach((p, i) => loadBuild(sim, p, snap.builds[i]!));
  return sim;
}

for (const meta of metas)
  for (const n of players)
    for (const archetype of archetypes)
      for (const seed of seeds) {
        const cell: Cell = { meta, players: n, archetype };
        const seen = new Set<number>();
        let lateChoices = 0,
          offered = 0,
          taken = 0;
        // Natural-run momentum after minute 15 (kiting first-choice bots), sampled each second.
        const runStacks: number[] = [];
        const observe = (sim: Sim) => {
          if (sim.state.time >= 15 * 60 && sim.state.tick % 30 === 0 && !sim.state.arena)
            for (const p of sim.state.players) if (!p.dead) runStacks.push(p.momentum);
          for (const c of sim.state.pendingChoices) {
            if (c.kind !== 'level-up' || seen.has(c.id)) continue;
            seen.add(c.id);
            if (sim.state.time < 15 * 60) continue;
            lateChoices++;
            if (c.options.some((o) => o.statId && OFFENSE.has(o.statId))) offered++;
            const first = c.options[0];
            if (first?.statId && OFFENSE.has(first.statId)) taken++;
          }
        };
        const started = Date.now();
        const snaps = naturalRun(cell, seed, minutes, true, () => {}, observe);
        emit({
          kind: 'run',
          variant,
          ...cell,
          seed,
          lateChoices,
          offered,
          taken,
          runStacksMean: mean(runStacks),
          runStacksMedian: quantile(runStacks, 0.5),
          runStacksP90: quantile(runStacks, 0.9),
          levels: snaps.map((s) => s.level),
          power: snaps.map((s) => mean(s.builds.map((b) => b.statsTaken.attack ?? 0))),
          reflexes: snaps.map((s) => mean(s.builds.map((b) => b.statsTaken.cooldown ?? 0))),
          ms: Date.now() - started,
        });
        for (const snap of snaps) {
          const kite = crowd(fromCheckpoint(cell, seed, snap), snap.minute, false);
          const stand = crowd(fromCheckpoint(cell, seed, snap), snap.minute, true);
          // The same build standing without the bonus (stacks still counted): Momentum's own share.
          const withoutBonus = (sim: Sim) => {
            patchTuning(sim, 'momentum', { perStack: 0 });
            return sim;
          };
          const standOff = momentumOn
            ? crowd(withoutBonus(fromCheckpoint(cell, seed, snap)), snap.minute, true)
            : null;
          const fight = (bonus: boolean) => {
            const sim = fromCheckpoint(cell, seed, snap);
            if (bonus)
              sim.state.players.forEach((p, i) => {
                p.momentum = kite.endStacks[i] ?? 0;
              });
            else patchTuning(sim, 'momentum', { perStack: 0 });
            const r = encounter(sim, cell, seed, snap.minute, 'natural', true, 0, true);
            return {
              won: 'won' in r ? r.won : null,
              ttk: 'ttk' in r ? r.ttk : null,
              hpFraction: r.hpRemoved / r.legendHp,
              fightDps: r.fightDps,
            };
          };
          const riftOn = n > 1 && snap.minute >= 20;
          const rift = riftOn ? fight(momentumOn) : null;
          const riftOff = riftOn && momentumOn ? fight(false) : null;
          emit({
            kind: 'checkpoint',
            variant,
            ...cell,
            seed,
            minute: snap.minute,
            level: snap.level,
            kite,
            stand,
            standOff,
            rift,
            riftOff,
          });
        }
      }
