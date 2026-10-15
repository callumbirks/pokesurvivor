// Manual balance diagnostics, deliberately outside the CI test suite.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { DT } from '../src/constants.js';
import { activeGroup } from '../src/moves.js';
import { defenseOf, hurtPlayer } from '../src/players.js';
import { bossScale, enemyScale, spawnOne } from '../src/spawner.js';
import type { PlayerState } from '../src/state.js';
import { resetChunks } from '../src/world.js';
import type { Sim } from '../src/index.js';
import { botInputs } from './bots.js';
import { applyV15 } from './variants.js';
import { patchTuning, postponeAmbientSystems, spawnDummy } from './helpers.js';
import {
  describe,
  loadBuild,
  makeSim,
  median,
  naturalRun,
  synthetic,
  type Cell,
  type Snapshot,
} from './measure-rifts.js';

export interface WildTrial extends Cell {
  kind: 'wild';
  phase: 'before' | 'after';
  minute: number;
  seed: number;
  profile: 'natural' | 'typical';
  builds: ReturnType<typeof describe>[];
  maxHp: number;
  /** Damage reduction equivalent of the defence: 1 − 1 / (1 + defence). */
  reduction: number;
  defense?: number;
  effectiveHp: number;
  contactPct: number;
  shotPct: number | null;
  skillPct: number | null;
  elitePct: number;
  bossPct: number | null;
  contactHits: number;
  shotHits: number | null;
  worstContactPct: number;
  worstShotPct: number;
  timeFactor: number;
  damageK: number;
  rosterBase: number;
  regularHp: number;
  teamDps: number;
  regularTtk: number | null;
  crowds: {
    stationary: ReturnType<typeof crowd>;
    kite: ReturnType<typeof crowd>;
    survival: ReturnType<typeof crowd>;
    survivalKite: ReturnType<typeof crowd>;
  } | null;
}

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [key, ...value] = s.replace(/^--/, '').split('=');
    return [key!, value.join('=')];
  }),
);
for (const key of args.keys())
  if (
    ![
      'out',
      'calibration',
      'meta',
      'players',
      'archetypes',
      'seeds',
      'minutes',
      'crowd-seconds',
      'legacy',
      'refresh-pressure',
      'v15',
    ].includes(key)
  )
    throw new Error(`unknown argument --${key}`);
const calibrationPath = args.get('calibration');
const cached = calibrationPath
  ? (() => {
      const bytes = readFileSync(calibrationPath);
      return (calibrationPath.endsWith('.gz') ? gunzipSync(bytes) : bytes)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s) as Snapshot)
        .filter((s) => s.kind === 'snapshot' && s.protected);
    })()
  : undefined;
const out = args.get('out');
if (out) writeFileSync(out, '');
const emit = (row: unknown) => {
  const line = JSON.stringify(row) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};
const numbers = (key: string, fallback: string) =>
  (args.get(key) ?? fallback).split(',').map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --${key}`);
    return n;
  });
const select = <T extends string>(key: string, values: T[]) => {
  const selected = (args.get(key) ?? values.join(',')).split(',') as T[];
  if (selected.some((s) => !values.includes(s))) throw new Error(`invalid --${key}`);
  return selected;
};
const minutes = [...new Set(numbers('minutes', '2,4,6,8,10,12,15,20'))].sort((a, b) => a - b);
const seeds = numbers('seeds', '7,99,2026');
const players = numbers('players', '1,2,4');
if (players.some((n) => ![1, 2, 4].includes(n)) || seeds.some((s) => !Number.isSafeInteger(s)))
  throw new Error('players must be 1,2,4; seeds must be integers');
const metas = select<Cell['meta']>('meta', ['none', 'half', 'max']);
const archetypes = select<Cell['archetype']>('archetypes', ['projectile', 'melee', 'area']);
const crowdSeconds = Number(args.get('crowd-seconds') ?? 30);
if (!Number.isFinite(crowdSeconds) || crowdSeconds < 0 || crowdSeconds > 120)
  throw new Error('crowd seconds must be 0–120');
const trialKey = (
  row: Pick<WildTrial, 'meta' | 'players' | 'archetype' | 'minute' | 'seed' | 'profile'>,
) => [row.meta, row.players, row.archetype, row.minute, row.seed, row.profile].join('/');
const refreshPath = args.get('refresh-pressure');
const previous = refreshPath
  ? (() => {
      const bytes = readFileSync(refreshPath);
      const rows = (refreshPath.endsWith('.gz') ? gunzipSync(bytes) : bytes)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as WildTrial)
        .filter((r) => r.kind === 'wild');
      const expectedPhase = args.has('legacy') ? 'before' : 'after';
      if (rows.some((r) => r.phase !== expectedPhase)) throw new Error('refresh phase mismatch');
      const map = new Map(rows.map((r) => [trialKey(r), r]));
      if (map.size !== rows.length) throw new Error('duplicate refresh trial');
      return map;
    })()
  : undefined;

// --v15: v15's rarity odds, Momentum and wild curves (`variants.ts`), for before/after.
if (args.has('v15')) applyV15();

function configure(sim: Sim) {
  if (args.has('legacy'))
    patchTuning(sim, 'spawner', {
      damageCurve: [
        { minute: 0, multiplier: 1 },
        { minute: 10000, multiplier: 1 + 10000 / 7 },
      ],
      regularHitCapFraction: 0,
    });
  patchTuning(sim, 'spawner', { shinyRate: Number.MIN_VALUE });
  postponeAmbientSystems(sim, 1e6);
  sim.state.spawner.bossIndex = sim.state.roster.bosses.length;
  sim.state.weather.current = null;
}

/** Ask the real damage path, including the melee discount, minimum hit and type chart.
 * Neutral values isolate scaling; typed values expose roster matchup extremes, clear weather.
 */
function damage(sim: Sim, p: PlayerState, raw: number, dex?: number, regular = false): number {
  const hp = p.hp;
  p.hp = 1e9;
  p.invuln = 0;
  hurtPlayer(
    sim.ctx,
    p,
    raw,
    dex === undefined ? null : sim.ctx.d.game.pokemonByDex.get(dex)!.types[0]!,
    regular,
  );
  const dealt = 1e9 - p.hp;
  p.hp = hp;
  p.invuln = 0;
  sim.drainEvents();
  return dealt;
}

function rosterProbe(sim: Sim) {
  const t = sim.state.time;
  const p = sim.state.players[0]!;
  const roster = sim.state.roster.tiers;
  const total = roster.reduce(
    (n, tier) => n + (t >= tier.from ? tier.list.length * (t - tier.from > 260 ? 3 : 10) : 0),
    0,
  );
  const rows = roster.flatMap((tier, tierIndex) =>
    t < tier.from
      ? []
      : tier.list.map((def) => {
          // Force one exact roster member through spawnOne to measure shipped HP/damage, including hpK.
          sim.state.roster.tiers = [{ from: 0, list: [def] }];
          sim.state.enemies = [];
          let enemy = spawnOne(sim.ctx, p, t);
          for (let attempt = 0; !enemy && attempt < 100; attempt++) enemy = spawnOne(sim.ctx, p, t);
          if (!enemy) throw new Error(`no free probe spawn for ${def.dex}`);
          const shotRaw =
            def.behavior === 'ranged' || def.behavior === 'fan'
              ? (((def.shotDamage || 10) * enemy.damage) / def.damage) *
                (def.behavior === 'fan' ? 0.65 : 1)
              : null;
          const skillRaw =
            def.behavior === 'bomber'
              ? enemy.damage * 1.4
              : def.behavior === 'jumper'
                ? enemy.damage * 1.2
                : def.behavior === 'beamer'
                  ? (((def.shotDamage || 10) * enemy.damage) / def.damage) * 1.05
                  : def.behavior === 'zoner'
                    ? (((def.shotDamage || 10) * enemy.damage) / def.damage) * 0.95
                    : null;
          return {
            tier: tierIndex,
            dex: def.dex,
            behavior: def.behavior,
            weight: (t - tier.from > 260 ? 3 : 10) / total,
            baseDamage: def.damage,
            raw: enemy.damage,
            hp: enemy.maxHp,
            contact: damage(sim, p, enemy.damage, undefined, true),
            typedContact: damage(sim, p, enemy.damage, def.dex, true),
            shot: shotRaw === null ? null : damage(sim, p, shotRaw, undefined, true),
            typedShot: shotRaw === null ? null : damage(sim, p, shotRaw, def.dex, true),
            skill: skillRaw === null ? null : damage(sim, p, skillRaw),
            elite: damage(sim, p, enemy.damage * 1.25),
          };
        }),
  );
  sim.state.roster.tiers = roster;
  sim.state.enemies = [];
  const avg = (key: 'baseDamage' | 'raw' | 'hp' | 'contact' | 'shot' | 'skill' | 'elite') => {
    const values = rows.filter((r) => r[key] !== null);
    const weight = values.reduce((n, r) => n + r.weight, 0);
    return weight ? values.reduce((n, r) => n + (r[key] ?? 0) * r.weight, 0) / weight : null;
  };
  const contact = avg('contact')!;
  const shot = avg('shot');
  const slot = sim.state.roster.bosses.filter((b) => b.at <= t).at(-1);
  const bossContact = slot ? damage(sim, p, slot.damage * bossScale(sim.ctx, t).damage) : null;
  return {
    rows,
    timeFactor: enemyScale(sim.ctx, t).damage,
    damageK: sim.ctx.d.game.tuning.spawner.damageK,
    rosterBase: avg('baseDamage')!,
    regularHp: avg('hp')!,
    contact,
    shot,
    skill: avg('skill'),
    elite: avg('elite'),
    boss: bossContact,
    contactPct: (contact / p.maxHp) * 100,
    shotPct: shot === null ? null : (shot / p.maxHp) * 100,
    skillPct: avg('skill') === null ? null : (avg('skill')! / p.maxHp) * 100,
    elitePct: (avg('elite')! / p.maxHp) * 100,
    bossPct: bossContact === null ? null : (bossContact / p.maxHp) * 100,
    contactHits: p.maxHp / contact,
    shotHits: shot === null ? null : p.maxHp / shot,
    worstContactPct: (Math.max(...rows.map((r) => r.typedContact)) / p.maxHp) * 100,
    worstShotPct: (Math.max(0, ...rows.map((r) => r.typedShot ?? 0)) / p.maxHp) * 100,
  };
}

/** Neutral close-range single-target potential; reference HP is a regular wild's for statuses. */
function wildDps(sim: Sim, cell: Cell, seed: number, hp: number): number {
  const test = makeSim(cell, seed, true, true);
  configure(test);
  test.state.time = sim.state.time;
  test.state.players.forEach((p, i) => loadBuild(test, p, sim.state.players[i]!));
  test.debugStartArena();
  const a = test.state.arena!;
  a.pillars = a.pools = test.state.world.arena!.pillars = test.state.world.arena!.pools = 0;
  resetChunks(test.ctx);
  test.state.enemies = [];
  const target = spawnDummy(test, a.x, a.y, {}, 1e9);
  target.types = [];
  target.flying = true;
  target.maxHp = hp;
  a.bossId = target.id;
  test.state.weather.current = null;
  test.state.players.forEach((p, i) => {
    p.x = p.prevX = a.x;
    p.y = p.prevY = a.y + 40 + i * 2;
  });
  for (let i = 0; i < 30 / DT; i++) {
    test.step();
    test.drainEvents();
    target.x = a.x;
    target.y = a.y;
    target.speed = 0;
    target.kx = target.ky = 0;
  }
  return (1e9 - target.hp) / 30;
}

/** Ring-spawned regular crowd, 15 s invulnerable warmup then fixed-loadout trial.
 * A health reserve during the pressure trial prevents deaths and survivor bias.
 * The separate ordinary trial records the first down, censored at crowdSeconds.
 */
function crowd(source: Sim, cell: Cell, seed: number, kite: boolean, pressure: boolean) {
  const sim = makeSim(cell, seed, false);
  configure(sim);
  sim.state.time = source.state.time;
  sim.state.players.forEach((p, i) => loadBuild(sim, p, source.state.players[i]!));
  const focal = sim.state.players[0]!;
  if (pressure)
    for (const p of sim.state.players) {
      // Healing/regen clamps ordinary HP to maxHp. A fixture-only accessor keeps the reserve
      // through those writes without changing maxHp (which the hit cap and statuses need).
      Object.defineProperty(p, 'hp', {
        get: () => 1e9,
        set: () => {
          /* Discard health writes in this pressure-only fixture. */
        },
        enumerable: true,
        configurable: true,
      });
    }
  let taken = 0;
  let firstDown: number | null = null;
  let enemies = 0;
  for (let tick = -Math.round(15 / DT); tick < Math.round(crowdSeconds / DT); tick++) {
    sim.state.config.invulnerable = tick < 0;
    // Freeze the checkpoint's spawn/damage curves while retaining ordinary AI/attack timers.
    sim.state.time = source.state.time;
    if (kite) botInputs(sim);
    else sim.state.players.forEach((p) => sim.setInput(p.id, { moveX: 0, moveY: 0 }));
    sim.state.pendingChoices = [];
    sim.state.pendingLevels = 0;
    sim.state.team.xp = 0;
    sim.state.team.xpNext = 1e12;
    if (pressure && tick >= 0)
      sim.state.players.forEach((p) => {
        p.hp = 1e9;
      });
    sim.step();
    if (pressure && sim.state.players.some((p) => p.dead))
      throw new Error('pressure reserve failed');
    if (tick >= 0) {
      enemies += sim.state.enemies.length;
      for (const event of sim.drainEvents())
        if (event.type === 'player-hurt' && event.playerId === focal.id) taken += event.amount;
      if (focal.dead && firstDown === null) firstDown = (tick + 1) * DT;
    } else sim.drainEvents();
    if (pressure || tick < 0) {
      // Restore only health/death bookkeeping; preserve real defensive buffs and invuln windows.
      sim.state.players.forEach((p) => {
        p.hp = p.maxHp;
        p.dead = false;
      });
      sim.state.ended = null;
    } else if (firstDown !== null) break;
  }
  return {
    dps: pressure ? taken / crowdSeconds : null,
    firstDown,
    censored: !pressure && firstDown === null,
    meanEnemies: pressure ? enemies / Math.round(crowdSeconds / DT) : null,
  };
}

emit({
  kind: 'metadata',
  schema: 1,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  calibrationPath,
  minutes,
  seeds,
  players,
  metas,
  archetypes,
  crowdSeconds,
  protectedCalibration: true,
  refreshPath,
  legacy: args.has('legacy'),
  spawnerTuning: (() => {
    const sim = makeSim({ meta: 'none', players: 1, archetype: 'area' }, 1, true);
    configure(sim);
    return sim.ctx.d.game.tuning.spawner;
  })(),
});
for (const meta of metas)
  for (const n of players)
    for (const archetype of archetypes) {
      const cell: Cell = { meta, players: n, archetype };
      const snapshots = cached
        ? cached.filter(
            (r) =>
              r.meta === meta &&
              r.players === n &&
              r.archetype === archetype &&
              seeds.includes(r.seed) &&
              minutes.includes(r.minute),
          )
        : seeds.flatMap((seed) => naturalRun(cell, seed, minutes, true, emit));
      for (const minute of minutes) {
        const calibration = snapshots.filter((s) => s.minute === minute);
        for (const seed of seeds) {
          const snapshot = calibration.filter((s) => s.seed === seed);
          if (snapshot.length !== 1)
            throw new Error(
              `missing or duplicate checkpoint ${meta}/${n}/${archetype}/${minute}/${seed}`,
            );
          for (const profile of ['natural', 'typical'] as const) {
            const sim = makeSim(cell, seed, true);
            configure(sim);
            sim.state.time = minute * 60;
            sim.state.team.level = snapshot[0]!.level;
            if (profile === 'natural')
              sim.state.players.forEach((p, i) => loadBuild(sim, p, snapshot[0]!.builds[i]!));
            else
              synthetic(
                sim,
                cell,
                Math.round(median(calibration.map((s) => s.level))),
                'typical',
                calibration,
              );
            const p = sim.state.players[0]!;
            const prior = previous?.get(trialKey({ ...cell, minute, seed, profile }));
            if (previous && !prior) throw new Error('missing refresh trial');
            const probe = rosterProbe(sim);
            if (
              prior &&
              JSON.stringify(prior.builds) !== JSON.stringify(sim.state.players.map(describe))
            )
              throw new Error('refresh build mismatch');
            const dps = prior?.teamDps ?? wildDps(sim, cell, seed, probe.regularHp);
            const crowds = crowdSeconds
              ? {
                  stationary: crowd(sim, cell, seed, false, true),
                  kite: crowd(sim, cell, seed, true, true),
                  survival: prior?.crowds?.survival ?? crowd(sim, cell, seed, false, false),
                  survivalKite: prior?.crowds?.survivalKite ?? crowd(sim, cell, seed, true, false),
                }
              : null;
            const result = {
              kind: 'wild' as const,
              phase: args.has('legacy') ? ('before' as const) : ('after' as const),
              ...cell,
              minute,
              seed,
              profile,
              builds: sim.state.players.map(describe),
              maxHp: p.maxHp,
              defense: defenseOf(sim.ctx, p),
              reduction: 1 - 1 / (1 + defenseOf(sim.ctx, p)),
              effectiveHp: p.maxHp * (1 + defenseOf(sim.ctx, p)),
              meleeMultiplier: activeGroup(p).some((m) => m.kind === 'melee') ? 0.75 : 1,
              ...probe,
              teamDps: dps,
              regularTtk: dps > 0 ? probe.regularHp / dps : null,
              crowds,
            };
            result satisfies WildTrial;
            emit(result);
          }
        }
      }
      process.stderr.write(`finished ${meta}/${n}/${archetype}\n`);
    }
