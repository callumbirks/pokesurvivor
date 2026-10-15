// Manual v12/v13 early-damage and horde-training diagnostics; never run in CI.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { DT } from '../src/constants.js';
import { hurtPlayer } from '../src/players.js';
import { spawnOne } from '../src/spawner.js';
import type { Sim } from '../src/index.js';
import type { PlayerState } from '../src/state.js';
import { isFree } from '../src/world.js';
import { patchTuning, postponeAmbientSystems } from './helpers.js';
import { loadBuild, makeSim, naturalRun, type Cell, type Snapshot } from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
for (const k of args.keys())
  if (!['out', 'calibration', 'phase', 'seeds', 'minutes', 'species', 'seconds'].includes(k))
    throw new Error(`unknown --${k}`);
const phase = args.get('phase') ?? 'before';
const seeds = (args.get('seeds') ?? '7,99,2026').split(',').map(Number);
const minutes = (args.get('minutes') ?? '2,4,6,8,10').split(',').map(Number);
const species = (args.get('species') ?? '4,1,25,887').split(',').map(Number);
const seconds = Number(args.get('seconds') ?? 60);
if (
  !['before', 'after'].includes(phase) ||
  [...seeds, ...species].some((n) => !Number.isSafeInteger(n) || n <= 0) ||
  minutes.some((n) => !Number.isFinite(n) || n <= 0) ||
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  seconds > 120
)
  throw new Error('invalid arguments');
const path = args.get('calibration');
if (path && path === args.get('out')) throw new Error('cannot overwrite calibration');
const cached = path
  ? readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s) as Snapshot)
      .filter((r) => r.kind === 'snapshot')
  : undefined;
const out = args.get('out');
if (out) writeFileSync(out, '');
const emit = (r: unknown) => {
  const line = JSON.stringify(r) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};
const ref = makeSim({ meta: 'half', players: 1, archetype: 'projectile' }, 7, true);
emit({
  kind: 'metadata',
  phase,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  minutes,
  seeds,
  species,
  seconds,
  tuning: ref.ctx.d.game.tuning,
  calibration: path,
  method:
    'paired protected earned loadouts; real terrain, no incoming death; straight/turn train, no attacks',
});
for (const dex of species) {
  const cell: Cell = {
    meta: 'half',
    players: 1,
    archetype: dex === 1 ? 'melee' : dex === 25 ? 'area' : 'projectile',
    dex,
  };
  const snaps =
    cached?.filter((r) => r.dex === dex) ??
    seeds.flatMap((seed) => naturalRun(cell, seed, minutes, true, emit));
  for (const seed of seeds)
    for (const minute of minutes) {
      const sources = snaps.filter((r) => r.minute === minute && r.seed === seed);
      if (sources.length !== 1) throw new Error('missing/duplicate checkpoint');
      const source = sources[0]!;
      // Repeat earned snapshots in the after artifact to make pairing independently checkable.
      if (cached) emit(source);
      const sim = makeSim(cell, seed, true);
      sim.state.time = minute * 60;
      loadBuild(sim, sim.state.players[0]!, source.builds[0]!);
      const contact = contactProbe(sim);
      for (const turning of [false, true])
        emit({
          kind: 'training',
          phase,
          dex,
          seed,
          minute,
          level: source.level,
          turning,
          contact,
          ...train(cell, seed, minute, source.builds[0]!, turning),
        });
    }
}
function contactProbe(sim: Sim) {
  const p = sim.state.players[0]!;
  const tiers = sim.state.roster.tiers;
  sim.state.config.invulnerable = false;
  let damage = 0,
    weight = 0;
  for (const tier of tiers) {
    if (tier.from > sim.state.time) continue;
    const w = sim.state.time - tier.from > 260 ? 3 : 10;
    for (const def of tier.list) {
      sim.state.roster.tiers = [{ from: 0, list: [def] }];
      sim.state.enemies = [];
      const e = spawnOne(sim.ctx, p, sim.state.time);
      if (!e) throw new Error('contact probe placement failed');
      p.hp = 1e9;
      p.invuln = 0;
      hurtPlayer(sim.ctx, p, e.damage, null, true);
      damage += (1e9 - p.hp) * w;
      weight += w;
    }
  }
  sim.state.roster.tiers = tiers;
  return { maxHp: p.maxHp, damage: damage / weight, hits: p.maxHp / (damage / weight) };
}
function train(cell: Cell, seed: number, minute: number, build: PlayerState, turning: boolean) {
  const sim = makeSim(cell, seed, false, true);
  const p = sim.state.players[0]!;
  loadBuild(sim, p, build);
  p.moves = [];
  p.slots = [];
  p.active = 0; // Deliberate gather phase: preserve the cohort rather than killing it.
  sim.state.time = minute * 60;
  postponeAmbientSystems(sim, 1e6);
  sim.state.spawner.bossIndex = sim.state.roster.bosses.length;
  sim.state.weather.current = null;
  patchTuning(sim, 'spawner', { shinyRate: Number.MIN_VALUE });
  const cohort = new Set<number>();
  // Gather real roster members behind the initial eastbound player.
  for (let i = 0; i < 16; i++) {
    const e = spawnOne(sim.ctx, p, sim.state.time, Math.PI);
    if (!e) continue;
    e.x = p.x - 240 - (i % 4) * 30;
    e.y = p.y + (Math.floor(i / 4) - 1.5) * 35;
    cohort.add(e.id);
  }
  let fresh = 0,
    freshAhead = 0,
    relocations = 0,
    relocatedAhead = 0,
    contacts = 0,
    pathTicks = 0,
    movingTicks = 0,
    cohortBehind = 0,
    cohortSamples = 0,
    heading = 0,
    travel = 0;
  let observedVx = 0,
    observedVy = 0;
  for (let tick = 0; tick < seconds / DT; tick++) {
    const direction = turning && Math.floor((tick * DT) / 12) % 2 ? Math.PI : 0;
    // Prefer the long run direction; steer around terrain without consulting enemy locations.
    let chosen = heading;
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.2, -1.2, 1.8, -1.8, Math.PI]) {
      const a = direction + turn;
      if (isFree(sim.ctx, p.x + Math.cos(a) * 45, p.y + Math.sin(a) * 45, p.r)) {
        chosen = a;
        break;
      }
    }
    heading = chosen;
    sim.setInput(p.id, { moveX: Math.cos(heading), moveY: Math.sin(heading) });
    const old = new Map(
      sim.state.enemies.map((e) => [e.id, { x: e.x, y: e.y, touchCd: e.touchCd }]),
    );
    const ox = p.x,
      oy = p.y;
    sim.state.time = minute * 60;
    sim.state.pendingChoices = [];
    sim.state.pendingLevels = 0;
    sim.state.team.xp = 0;
    sim.state.team.xpNext = 1e12;
    sim.step();
    const events = sim.drainEvents();
    travel += Math.hypot(p.x - ox, p.y - oy);
    // Evaluate the path against recent actual movement, rather than this tick's requested input.
    // Use the same independent 1.5-second ruler in both phases, including pre-history states.
    const alpha = 1 - Math.exp(-DT / 1.5);
    observedVx += ((p.x - ox) / DT - observedVx) * alpha;
    observedVy += ((p.y - oy) / DT - observedVy) * alpha;
    const vx = observedVx,
      vy = observedVy,
      speed = Math.hypot(vx, vy);
    const dx = speed > 1 ? vx / speed : Math.cos(heading),
      dy = speed > 1 ? vy / speed : Math.sin(heading);
    let path = false;
    for (const e of sim.state.enemies) {
      const before = old.get(e.id),
        x = e.x - p.x,
        y = e.y - p.y,
        dot = x * dx + y * dy;
      if (before && e.touchCd > before.touchCd + DT) contacts++;
      if (speed > 35) {
        if (dot > 0 && dot < 350 && Math.abs(x * dy - y * dx) < 60 + e.r) path = true;
        if (cohort.has(e.id)) {
          cohortSamples++;
          if (dot < 0) cohortBehind++;
        }
        if (before && Math.hypot(e.x - before.x, e.y - before.y) > 200) {
          relocations++;
          if (dot > 0) relocatedAhead++;
        }
      }
    }
    if (speed > 35) {
      movingTicks++;
      if (path) pathTicks++;
    }
    for (const event of events)
      if (event.type === 'enemy-spawned') {
        const e = sim.state.enemies.find((e) => e.id === event.id);
        // Separate ordinary ring arrivals from summons next to an existing enemy.
        if (e && Math.hypot(e.x - p.x, (e.y - p.y) / 0.9) > 600 && speed > 35) {
          fresh++;
          if ((e.x - p.x) * dx + (e.y - p.y) * dy > 0) freshAhead++;
        }
      }
  }
  return {
    seconds,
    travel,
    contacts,
    contactsPerMinute: (contacts / seconds) * 60,
    fresh,
    freshAhead,
    relocations,
    relocatedAhead,
    pathFraction: movingTicks ? pathTicks / movingTicks : null,
    cohortBehindFraction: cohortSamples ? cohortBehind / cohortSamples : null,
    movingFraction: movingTicks / (seconds / DT),
  };
}
