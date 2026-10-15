// Manual R8 step 3 diagnostics. This file never changes production tuning or runs in CI.
// Calibrate: pnpm --filter @pokesurvivor/sim late-growth --mode=calibrate --out=builds.jsonl
// Measure:   pnpm --filter @pokesurvivor/sim late-growth --calibration=builds.jsonl --out=late.jsonl
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { equip } from '../src/items.js';
import { DT } from '../src/constants.js';
import type { Sim } from '../src/index.js';
import { activeGroup, canLevelUp, evolutionInfo } from '../src/moves.js';
import { enemyScale, scaleHp, scaleRate, spawnRate } from '../src/spawner.js';
import { resetChunks } from '../src/world.js';
import { botInputs } from './bots.js';
import { patchTuning, postponeAmbientSystems, spawnDummy } from './helpers.js';
import {
  describe,
  encounter,
  loadBuild,
  makeSim,
  median,
  naturalRun,
  synthetic,
  type Cell,
  type Snapshot,
} from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
for (const key of args.keys())
  if (
    ![
      'mode',
      'out',
      'calibration',
      'minutes',
      'players',
      'meta',
      'seeds',
      'archetypes',
      'multipliers',
    ].includes(key)
  )
    throw new Error(`unknown --${key}`);
const numbers = (key: string, fallback: string) =>
  (args.get(key) ?? fallback).split(',').map(Number);
const minutes = [...new Set(numbers('minutes', '15,20,25,30,35'))].sort((a, b) => a - b);
const seeds = numbers('seeds', '7,99,2026');
const players = numbers('players', '1,3,4');
const multipliers = numbers('multipliers', '1');
const metas = (args.get('meta') ?? 'half,max').split(',') as Cell['meta'][];
const archetypes = (args.get('archetypes') ?? 'projectile,melee,area').split(
  ',',
) as Cell['archetype'][];
const mode = args.get('mode') ?? 'measure';
if (
  !['calibrate', 'measure'].includes(mode) ||
  minutes.some((n) => !Number.isFinite(n) || n <= 0 || n > 60) ||
  seeds.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
  players.some((n) => ![1, 3, 4].includes(n)) ||
  multipliers.some((n) => !Number.isFinite(n) || n <= 0) ||
  metas.some((m) => !['half', 'max'].includes(m)) ||
  archetypes.some((a) => !['projectile', 'melee', 'area'].includes(a))
)
  throw new Error('invalid matrix');
const out = args.get('out');
if (out && out === args.get('calibration'))
  throw new Error('output must not overwrite calibration');
if (out) writeFileSync(out, '');
const emit = (row: unknown) => {
  const line = JSON.stringify(row) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};
const reference = makeSim({ meta: 'half', players: 3, archetype: 'area' }, 7, true);
emit({
  kind: 'metadata',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  mode,
  minutes,
  seeds,
  players,
  metas,
  archetypes,
  multipliers,
  protectedCalibration: true,
  tuning: reference.ctx.d.game.tuning,
  method: 'neutral fixed dummies + real typed wild crowd; protected offense; fixed loadouts',
});

function configure(sim: Sim) {
  postponeAmbientSystems(sim, 1e6);
  sim.state.spawner.bossIndex = sim.state.roster.bosses.length;
  sim.state.weather.current = null;
  patchTuning(sim, 'spawner', { shinyRate: Number.MIN_VALUE });
}
function audit(sim: Sim) {
  return sim.state.players.map((p) => ({
    ...describe(p),
    activeMoves: activeGroup(p).length,
    upgradeable: p.moves.filter((m) => canLevelUp(sim.ctx, m)).length,
    maxed: p.moves.filter((m) => !canLevelUp(sim.ctx, m)).length,
    readyEvolutions: p.moves.filter((m) => evolutionInfo(sim.ctx, p, m)?.ready).length,
    waitingEvolutions: p.moves.filter((m) => {
      const e = evolutionInfo(sim.ctx, p, m);
      return e && !e.ready;
    }).length,
    powerCardMul: p.cardMul.attack ?? 1,
    reflexesCardMul: p.cardMul.cooldown ?? 1,
  }));
}

if (mode === 'calibrate') {
  for (const meta of metas)
    for (const n of players)
      for (const archetype of archetypes)
        for (const seed of seeds) {
          const cell: Cell = { meta, players: n, archetype };
          const seen = new Set<number>();
          const offers: Record<string, number> = {};
          const picks: Record<string, number> = {};
          let count = 0,
            offenseOffered = 0;
          const observe = (sim: Sim) => {
            for (const c of sim.state.pendingChoices) {
              if (c.kind !== 'level-up' || seen.has(c.id)) continue;
              seen.add(c.id);
              count++;
              if (c.options.some((o) => o.statId === 'attack' || o.statId === 'cooldown'))
                offenseOffered++;
              for (const o of c.options) {
                const key = o.statId ?? o.type;
                offers[key] = (offers[key] ?? 0) + 1;
              }
              const o = c.options[0];
              if (o) {
                const key = o.statId ?? o.type;
                picks[key] = (picks[key] ?? 0) + 1;
              }
            }
          };
          naturalRun(
            cell,
            seed,
            minutes,
            true,
            (row) => {
              emit(row);
              if ((row as Snapshot).kind === 'snapshot')
                emit({
                  kind: 'cards',
                  ...cell,
                  seed,
                  minute: (row as Snapshot).minute,
                  count,
                  offenseOffered,
                  offers: { ...offers },
                  picks: { ...picks },
                });
            },
            observe,
          );
        }
} else {
  const path = args.get('calibration');
  if (!path) throw new Error('--calibration required');
  const bytes = readFileSync(path);
  const rows = (path.endsWith('.gz') ? gunzipSync(bytes) : bytes)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s) as { kind: string; tuning?: unknown; protected?: boolean });
  const metadata = rows.filter((r) => r.kind === 'metadata');
  if (
    !metadata.length ||
    metadata.some((r) => JSON.stringify(r.tuning) !== JSON.stringify(reference.ctx.d.game.tuning))
  )
    throw new Error('calibration tuning differs from current tuning; earn fresh checkpoints');
  const cached = rows.filter((r): r is Snapshot => r.kind === 'snapshot' && r.protected === true);
  for (const meta of metas)
    for (const n of players)
      for (const archetype of archetypes)
        for (const minute of minutes) {
          const cell: Cell = { meta, players: n, archetype };
          const calibration = cached.filter(
            (s) =>
              s.meta === meta &&
              s.players === n &&
              s.archetype === archetype &&
              s.minute === minute &&
              seeds.includes(s.seed),
          );
          for (const seed of seeds)
            for (const profile of ['natural', 'typical'] as const) {
              const snapshots = calibration.filter((s) => s.seed === seed);
              if (snapshots.length !== 1)
                throw new Error(
                  `missing/duplicate checkpoint ${JSON.stringify({ ...cell, minute, seed })}`,
                );
              const make = (multiplier = 1) => {
                const sim = makeSim(cell, seed, true, true);
                configure(sim);
                sim.state.time = minute * 60;
                sim.state.team.level = snapshots[0]!.level;
                if (profile === 'natural')
                  sim.state.players.forEach((p, i) => loadBuild(sim, p, snapshots[0]!.builds[i]!));
                else
                  synthetic(
                    sim,
                    cell,
                    Math.round(median(calibration.map((s) => s.level))),
                    'typical',
                    calibration,
                  );
                for (const p of sim.state.players) p.attackMul *= multiplier;
                return sim;
              };
              const sim = make();
              const roster = sim.state.roster.tiers.flatMap((t) =>
                minute * 60 < t.from
                  ? []
                  : t.list.map((def) => ({ def, w: minute * 60 - t.from > 260 ? 3 : 10 })),
              );
              const weights = roster.reduce((a, r) => a + r.w, 0);
              const hp =
                (roster.reduce((a, r) => a + r.def.hp * r.w, 0) / weights) *
                enemyScale(sim.ctx, minute * 60).hp *
                scaleHp(n) *
                (3.3 + Math.min(1.7, (minute * 60) / 210));
              const single = potential(make(), hp, 1);
              const aoe = potential(make(), hp, 64);
              const early = cached.find(
                (s) =>
                  s.meta === meta &&
                  s.players === n &&
                  s.archetype === archetype &&
                  s.seed === seed &&
                  s.minute <= 15,
              );
              if (!early)
                throw new Error('minute 15 calibration is required for growth attribution');
              const earlier = () => {
                const test = makeSim(cell, seed, true, true);
                configure(test);
                test.state.time = minute * 60;
                test.state.team.level = early.level;
                if (profile === 'natural')
                  test.state.players.forEach((p, i) => loadBuild(test, p, early.builds[i]!));
                else
                  synthetic(
                    test,
                    cell,
                    Math.round(
                      median(
                        cached
                          .filter(
                            (s) =>
                              s.meta === meta &&
                              s.players === n &&
                              s.archetype === archetype &&
                              s.minute <= 15 &&
                              seeds.includes(s.seed),
                          )
                          .map((s) => s.level),
                      ),
                    ),
                    'typical',
                    cached.filter(
                      (s) =>
                        s.meta === meta &&
                        s.players === n &&
                        s.archetype === archetype &&
                        s.minute <= 15 &&
                        seeds.includes(s.seed),
                    ),
                  );
                return test;
              };
              const earlyBuild = earlier();
              const ablate = (kind: 'cards' | 'items' | 'bonds') => {
                const test = make();
                test.state.players.forEach((p, i) => {
                  const old = earlyBuild.state.players[i]!;
                  if (kind === 'cards') {
                    // What the later picks built (checkpoints from before rarities: none).
                    const built = (id: string) => (p.cardMul?.[id] ?? 1) / (old.cardMul?.[id] ?? 1);
                    p.attackMul /= built('attack');
                    p.cooldownMul /= built('cooldown');
                  } else if (kind === 'items') equip(test.ctx, p, old.item);
                  else {
                    p.slots = structuredClone(old.slots);
                    p.active = old.active;
                  }
                });
                return potential(test, hp, 1);
              };
              const attribution =
                minute <= 15
                  ? null
                  : {
                      frozen15Dps: potential(earlyBuild, hp, 1),
                      withoutLateOffenseCards: ablate('cards'),
                      withoutLateItems: ablate('items'),
                      withoutLateBonds: ablate('bonds'),
                    };
              const crowdResults = multipliers.map((multiplier) => ({
                multiplier,
                ...crowd(make(multiplier), minute),
              }));
              // Moving legend: record actual 120-second result as well as the sustained 60-second estimate.
              const rift =
                n > 1 && minute >= 20
                  ? {
                      probe: encounter(make(), cell, seed, minute, profile, true, 60, true),
                      fight: encounter(make(), cell, seed, minute, profile, true, 0, true),
                    }
                  : null;
              emit({
                kind: 'late',
                ...cell,
                seed,
                minute,
                profile,
                level: sim.state.team.level,
                builds: audit(sim),
                attribution,
                regularHp: hp,
                singleDps: single,
                aoeDps: aoe,
                regularTtk: hp / single,
                nominalSpawnRate: spawnRate(sim.ctx, minute * 60) * scaleRate(n),
                crowds: crowdResults,
                rift,
              });
            }
        }
}

/** Fixed neutral targets; sum real health loss, including statuses; no overkill. */
function potential(sim: Sim, hp: number, count: number) {
  sim.debugStartArena();
  const a = sim.state.arena!;
  a.pillars = a.pools = sim.state.world.arena!.pillars = sim.state.world.arena!.pools = 0;
  resetChunks(sim.ctx);
  sim.state.enemies = [];
  const targets = Array.from({ length: count }, (_, i) => {
    const angle = i * 2.399963229728653,
      radius = count === 1 ? 0 : Math.sqrt(i / (count - 1)) * 160;
    const x = a.x + Math.cos(angle) * radius,
      y = a.y + Math.sin(angle) * radius;
    const e = spawnDummy(sim, x, y, {}, 1e9);
    e.maxHp = hp;
    e.types = [];
    e.flying = true;
    return { e, x, y };
  });
  a.bossId = targets[0]!.e.id;
  sim.state.players.forEach((p, i) => {
    p.x = p.prevX = a.x;
    p.y = p.prevY = a.y + 40 + i * 2;
  });
  for (let tick = 0; tick < 30 / DT; tick++) {
    sim.step();
    sim.drainEvents();
    for (const { e, x, y } of targets) {
      e.x = x;
      e.y = y;
      e.speed = 0;
      e.kx = e.ky = 0;
    }
  }
  return targets.reduce((sum, { e }) => sum + 1e9 - e.hp, 0) / 30;
}

/** Actual ring spawner, terrain and typed enemies; 15s warmup + 60s observation.
 * Immortality isolates offense. Cap suppression is NOT interpreted as cleared demand. */
function crowd(sim: Sim, minute: number) {
  sim.state.config.noSpawns = false;
  const seconds = 60;
  let kills = 0,
    admitted = 0,
    occupied = 0,
    full = 0;

  for (let tick = -Math.round(15 / DT); tick < seconds / DT; tick++) {
    sim.state.time = minute * 60;
    sim.state.pendingChoices = [];
    sim.state.pendingLevels = 0;
    sim.state.team.xp = 0;
    sim.state.team.xpNext = 1e12;
    botInputs(sim);
    sim.step();
    for (const event of sim.drainEvents())
      if (tick >= 0 && event.type === 'enemy-spawned') admitted++;
    const total = sim.state.team.kills;
    if (tick === -1) kills = -total;
    if (tick >= 0) {
      occupied += sim.state.enemies.length;
      if (sim.state.enemies.length >= sim.ctx.d.game.tuning.spawner.cap * 0.85) full++;
    }
  }
  kills += sim.state.team.kills;
  return {
    seconds,
    kills,
    killsPerSecond: kills / seconds,
    admittedPerSecond: admitted / seconds,
    meanEnemies: occupied / (seconds / DT),
    crowdedFraction: full / (seconds / DT),
  };
}
