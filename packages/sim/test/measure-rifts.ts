// Manual measurement only: never imported by the default *.test.ts suite.
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DT, TILE } from '../src/constants.js';
import { equip } from '../src/items.js';
import { applyCard } from '../src/levelup.js';
import { activeGroup, evolutionInfo, newMove, setActive } from '../src/moves.js';
import { createSim, type PlayerState, type Sim } from '../src/index.js';
import { isFree, resetChunks } from '../src/world.js';
import { botInputs, pickFirst } from './bots.js';
import { spawnDummy } from './helpers.js';

export const archetypes = {
  projectile: { dex: 4, moves: ['ember', 'flamethrower', 'fire-spin', 'swords-dance'] },
  melee: { dex: 1, moves: ['vine-whip', 'quick-attack', 'tackle', 'swords-dance'] },
  area: { dex: 25, moves: ['thunder-shock', 'discharge', 'thunderbolt', 'swords-dance'] },
} as const;
export type Archetype = keyof typeof archetypes;
export type Meta = 'none' | 'half' | 'max';
export type Profile = 'natural' | 'weak' | 'typical' | 'strong';
export interface Cell {
  archetype: Archetype;
  meta: Meta;
  players: number;
}
export interface Snapshot extends Cell {
  kind: 'snapshot';
  seed: number;
  minute: number;
  level: number;
  protected: boolean;
  builds: PlayerState[];
}
export interface Trial extends Cell {
  kind: 'trial';
  seed: number;
  minute: number;
  profile: Profile;
  calibrationProtected: boolean;
  level: number;
  builds: ReturnType<typeof describe>[];
  legendDex: number;
  shiny: boolean;
  legendHp: number;
  legendDamage: number;
  legendShotDamage: number;
  won: boolean;
  ttk: number | null;
  fightSeconds: number;
  damageTaken: number;
  downs: number;
  hpRemoved: number;
  fightDps: number;
  dummyDps: number;
}
export const median = (xs: number[]): number => {
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (!sorted.length) throw new Error('median of empty sample');
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function makeSim(cell: Cell, seed: number, noSpawns: boolean, invulnerable = false): Sim {
  const probe = createSim({ seed: 1, players: [{ id: 'probe', dex: 25 }] });
  const upgrades = Object.fromEntries(
    probe.ctx.d.game.upgrades.map((u) => [
      u.id,
      cell.meta === 'max' ? u.maxLevel : cell.meta === 'half' ? Math.floor(u.maxLevel / 2) : 0,
    ]),
  );
  return createSim({
    seed,
    players: Array.from({ length: cell.players }, (_, i) => ({
      id: `p${i}`,
      dex: archetypes[cell.archetype].dex,
      upgrades,
    })),
    debug: { noSpawns, invulnerable },
  });
}

function describe(p: PlayerState) {
  return {
    dex: p.dex,
    moves: p.moves.map((m) => ({ id: m.id, level: m.level, evolved: m.evolved })),
    slots: p.slots,
    active: p.active,
    item: p.item,
    statsTaken: p.statsTaken,
    attackMul: p.attackMul,
    cooldownMul: p.cooldownMul,
    maxHp: p.maxHp,
    damageReduction: p.damageReduction,
    riftWins: p.stats.progress.riftWins.length,
  };
}

/** Reuse earned loadouts, but start each isolated encounter healed, without temporary powers. */
function loadBuild(sim: Sim, p: PlayerState, source: PlayerState): void {
  const keys = [
    'maxHp',
    'attackMul',
    'speedMul',
    'cooldownMul',
    'damageReduction',
    'regen',
    'magnet',
    'xpMul',
    'coinMul',
    'critChance',
    'moves',
    'slots',
    'active',
    'maxSlots',
    'statsTaken',
    'item',
    'itemRegen',
  ] as const;
  for (const key of keys) Object.assign(p, { [key]: structuredClone(source[key]) });
  for (const m of p.moves) {
    m.t = 0;
    m.castTick = -1;
  }
  p.hp = p.maxHp;
  p.stats.progress = structuredClone(source.stats.progress);
  sim.drainEvents();
}

function engagementDistance(p: PlayerState): number {
  const distances = activeGroup(p)
    .filter((m) => m.kind !== 'buff')
    .map((m) => {
      if (['melee', 'aura', 'orbit', 'dash'].includes(m.kind)) return (m.stats.radius ?? 70) * 0.65;
      if (m.kind === 'cone') return 75;
      return 125;
    });
  return Math.max(35, Math.min(125, ...distances));
}

/** Follow the existing reverse BFS field from the goal back to the player's origin.
 * Loot/rifts can be behind long walls: local angle steering alone systematically underlevels
 * bots. Navigation is a harness policy; it does not change sim pathfinding or gameplay.
 */
function waypoint(sim: Sim, p: PlayerState, goal: { x: number; y: number }) {
  const field = sim.ctx.paths.get(p.id);
  if (!field) return goal;
  const size = Math.sqrt(field.dist.length);
  const gx = Math.floor(goal.x / TILE) - field.ox;
  const gy = Math.floor(goal.y / TILE) - field.oy;
  let best = -1;
  let score = Infinity;
  for (let y = gy - 1; y <= gy + 1; y++)
    for (let x = gx - 1; x <= gx + 1; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const i = y * size + x;
      const d = field.dist[i]!;
      if (d === 0x7fff) continue;
      const candidate = Math.hypot(x - gx, y - gy) + d * 0.001;
      if (candidate < score) {
        best = i;
        score = candidate;
      }
    }
  if (best < 0) return null;
  const path: { x: number; y: number }[] = [];
  let at = best;
  while (field.dist[at]! > 0) {
    const x = at % size;
    const y = Math.floor(at / size);
    path.push({ x: (field.ox + x + 0.5) * TILE, y: (field.oy + y + 0.5) * TILE });
    let next = -1;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const nx = x + dx!;
      const ny = y + dy!;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (dx && dy && (!field.open[y * size + nx] || !field.open[ny * size + x])) continue;
      const i = ny * size + nx;
      if (field.dist[i]! < field.dist[at]!) {
        next = i;
        break;
      }
    }
    if (next < 0) return null;
    at = next;
  }
  path.reverse();
  // The field origin can be up to 0.35 s old: skip points already passed since its build.
  let closest = 0;
  for (let i = 1; i < Math.min(4, path.length); i++) {
    if (
      Math.hypot(path[i]!.x - p.x, path[i]!.y - p.y) <
      Math.hypot(path[closest]!.x - p.x, path[closest]!.y - p.y)
    )
      closest = i;
  }
  const near = path[closest];
  if (near && Math.hypot(near.x - p.x, near.y - p.y) > 18) return near;
  return path[Math.min(closest + 1, path.length - 1)] ?? goal;
}

/** Deterministic loot/rift seeking; upgrade, item and bond decisions remain pickFirst. */
function drive(sim: Sim): void {
  botInputs(sim);
  const s = sim.state;
  for (const p of s.players) {
    if (p.dead) continue;
    const down = s.players.find((o) => o.dead && !o.left);
    const boss = s.enemies.find((e) => e.legend && !e.dead);
    let target: { x: number; y: number } | undefined;
    let desired = 0;
    let strafe = 0;
    if (down) {
      target = down;
      desired = 15;
    } else if (s.arena && boss) {
      target = boss;
      desired = engagementDistance(p);
      strafe = 0.65 * (p.index % 2 ? -1 : 1);
    } else if (!s.arena) {
      if (s.rift.open) target = { x: s.rift.open.x, y: s.rift.open.y - 10 };
      else {
        let best = Infinity;
        for (const pk of s.pickups) {
          const d = Math.hypot(pk.x - p.x, pk.y - p.y);
          if (d < best && d < 650) {
            best = d;
            target = pk;
          }
        }
        if (!target) {
          for (const e of s.enemies) {
            if (e.dead) continue;
            const d = Math.hypot(e.x - p.x, e.y - p.y);
            if (d < best) {
              best = d;
              target = e;
            }
          }
          desired = engagementDistance(p);
          strafe = 0.3;
        }
      }
    }
    if (!target) continue;
    if (Math.hypot(target.x - p.x, target.y - p.y) > desired + 60) {
      const route = waypoint(sim, p, target);
      if (!route) continue; // Let the existing wandering policy escape unreachable goals.
      target = route;
      desired = 0;
      strafe = 0;
    }
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const distance = Math.hypot(dx, dy) || 1;
    const radial = Math.max(-1, Math.min(1, (distance - desired) / 40));
    const vx = (dx * radial - dy * strafe) / distance;
    const vy = (dy * radial + dx * strafe) / distance;
    const a = Math.atan2(vy, vx);
    const speed = Math.min(1, Math.hypot(vx, vy));
    // Local obstacle avoidance, with a periodic change of side to escape corners.
    const side = Math.floor(s.time / 3) % 2 ? -1 : 1;
    for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 2, -2, Math.PI]) {
      const x = Math.cos(a + turn * side) * speed;
      const y = Math.sin(a + turn * side) * speed;
      if (!isFree(sim.ctx, p.x + x * TILE, p.y + y * TILE, p.r)) continue;
      sim.setInput(p.id, { moveX: x, moveY: y });
      break;
    }
  }
}

/** pickFirst may learn a buff into the active slot. A human switches back to an attack;
 * without slot selection a first-choice bot can stop killing permanently at level three.
 * Rank slots by damage/cooldown (not learned move count), preserving Choice Band's lock.
 */
function selectAttackSlot(sim: Sim): void {
  for (const p of sim.state.players) {
    if (p.dead || p.item === 'choice-band') continue;
    const score = (group: string[]) =>
      group.reduce((sum, id) => {
        const m = p.moves.find((m) => m.id === id)!;
        return sum + (m.stats.damage ?? 0) / (m.stats.cooldown ?? 1);
      }, 0);
    const current = score(p.slots[p.active] ?? []);
    let best = p.active;
    for (let i = 0; i < p.slots.length; i++) {
      if (score(p.slots[i]!) > score(p.slots[best]!) + 0.01) best = i;
    }
    if (score(p.slots[best]!) > current + 0.01) sim.setInput(p.id, { ...p.input, slot: best });
  }
}

function naturalRun(
  cell: Cell,
  seed: number,
  minutes: number[],
  protectedRun: boolean,
  emit: (v: unknown) => void,
): Snapshot[] {
  const sim = makeSim(cell, seed, false, protectedRun);
  const snapshots: Snapshot[] = [];
  for (const minute of minutes) {
    while (sim.state.time + DT / 2 < minute * 60 && !sim.ended) {
      pickFirst(sim);
      drive(sim);
      selectAttackSlot(sim);
      sim.step();
      sim.drainEvents();
    }
    if (sim.ended) break;
    pickFirst(sim);
    const snapshot: Snapshot = {
      kind: 'snapshot',
      ...cell,
      seed,
      minute,
      protected: protectedRun,
      level: sim.state.team.level,
      builds: structuredClone(sim.state.players),
    };
    snapshots.push(snapshot);
    emit(snapshot);
  }
  emit({
    kind: 'progression',
    ...cell,
    seed,
    protected: protectedRun,
    reachedSeconds: sim.state.time,
    ended: sim.ended,
    level: sim.state.team.level,
    downs: sim.state.players.reduce((a, p) => a + p.stats.timesDown, 0),
  });
  return snapshots;
}

/** Spend a calibrated number of real level-up cards; no invented attack/HP multipliers. */
function synthetic(
  sim: Sim,
  cell: Cell,
  level: number,
  profile: Exclude<Profile, 'natural'>,
  calibration: Snapshot[],
): void {
  const plan = archetypes[cell.archetype];
  const budgets = { weak: 0.65, typical: 1, strong: 1.35 };
  const budget = Math.max(0, Math.round((level - 1) * budgets[profile]));
  sim.state.team.level = budget + 1;
  for (const p of sim.state.players) {
    // Repertoire's second move is random in a normal run. Explicit synthetic builds replace it
    // with the next move in this archetype's legal pool (the free move still costs no card).
    const freeMoves = p.moves.length;
    p.moves = plan.moves.slice(0, freeMoves).map((id) => newMove(sim.ctx, id));
    p.slots = p.moves.map((m) => [m.id]);
    p.active = cell.archetype === 'area' && freeMoves > 1 ? 1 : 0;
    const sources = calibration.flatMap((c) => c.builds);
    // Pick a median earned build, then explicitly reconstruct its move/stat progression using
    // this archetype's moves. This preserves the natural upgrade spread instead of spending
    // every early card on a single evolved attack and calling that "typical".
    const ranked = sources
      .slice()
      .sort(
        (a, b) =>
          a.moves.reduce((n, m) => n + m.level + Number(m.evolved), 0) -
          b.moves.reduce((n, m) => n + m.level + Number(m.evolved), 0),
      );
    const source = ranked[Math.floor(ranked.length / 2)]!;
    const desiredCount = Math.min(4, source.moves.length);
    let spent = 0;
    while (p.moves.length < desiredCount && spent < budget) {
      const id = plan.moves[p.moves.length]!;
      applyCard(sim.ctx, p, { id: `new:${id}`, type: 'new', moveId: id });
      spent++;
    }
    const primary = cell.archetype === 'area' && p.moves.length > 1 ? p.moves[1]! : p.moves[0]!;
    p.active = p.slots.findIndex((g) => g.includes(primary.id));
    const statQueue = Object.entries(source.statsTaken).flatMap(([id, n]) =>
      Array.from({ length: n }, () => id),
    );
    let statIndex = 0;
    const order = [primary, ...p.moves.filter((m) => m !== primary)];
    const activeIds = source.slots[source.active] ?? [];
    const earnedOrder = [
      ...source.moves.filter((m) => activeIds.includes(m.id)),
      ...source.moves.filter((m) => !activeIds.includes(m.id)),
    ];
    while (spent < budget) {
      const m = order.find((m) => {
        const earned = earnedOrder[order.indexOf(m)];
        return (
          m.level < Math.min(earned?.level ?? 1, sim.ctx.d.maxMoveLevel(m.id)) ||
          (!!earned?.evolved && !!evolutionInfo(sim.ctx, p, m))
        );
      });
      const ev = m && evolutionInfo(sim.ctx, p, m);
      if (m && m.level < sim.ctx.d.maxMoveLevel(m.id) && spent % 3 !== 2) {
        applyCard(sim.ctx, p, { id: `upgrade:${m.id}`, type: 'upgrade', moveId: m.id });
      } else if (m && ev?.ready) {
        applyCard(sim.ctx, p, { id: `evolution:${m.id}`, type: 'evolution', moveId: m.id });
      } else {
        // Strong builds use additional cards for offensive stats once the earned spread is met.
        let id =
          ev?.needs ??
          statQueue[statIndex] ??
          (profile === 'strong' ? (statIndex % 2 ? 'attack' : 'cooldown') : 'max-hp');
        statIndex++;
        const card = sim.ctx.d.statCard(id);
        if (card.maxPicks && (p.statsTaken[id] ?? 0) >= card.maxPicks) id = 'max-hp';
        applyCard(sim.ctx, p, { id: `stat:${id}`, type: 'stat', statId: id });
      }
      spent++;
    }
    const wins = Math.round(median(sources.map((p) => p.stats.progress.riftWins.length)));
    // Bonds are previous-rift rewards, independent of level-up card budget.
    const bonds = Math.max(0, wins + (profile === 'weak' ? -1 : profile === 'strong' ? 1 : 0));
    const groupSize = Math.min(p.moves.length, bonds > 0 ? bonds + 1 : 1, 4);
    const ids = [primary.id, ...p.moves.filter((m) => m !== primary).map((m) => m.id)];
    p.slots = [ids.slice(0, groupSize), ...ids.slice(groupSize).map((id) => [id])];
    p.active = 0;
    const counts = new Map<string | null, number>();
    for (const source of sources) counts.set(source.item, (counts.get(source.item) ?? 0) + 1);
    const typicalItem = [...counts].sort(
      (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
    )[0]![0];
    equip(
      sim.ctx,
      p,
      profile === 'weak' ? null : profile === 'strong' ? 'choice-band' : typicalItem,
    );
    p.hp = p.maxHp;
  }
}

function dummyDps(sim: Sim, cell: Cell, seed: number): number {
  const dummy = makeSim(cell, seed, true, true);
  dummy.state.time = sim.state.time;
  dummy.state.team.level = sim.state.team.level;
  dummy.state.players.forEach((p, i) => {
    loadBuild(dummy, p, sim.state.players[i]!);
    p.x = p.prevX = 0;
    p.y = p.prevY = i * 8;
  });
  dummy.debugStartArena();
  const reference = dummy.state.enemies[0]!;
  const referenceHp = reference.maxHp;
  const referenceRadius = reference.r;
  dummy.state.enemies = [];
  const a = dummy.state.arena!;
  a.pillars = a.pools = 0;
  dummy.state.world.arena!.pillars = dummy.state.world.arena!.pools = 0;
  resetChunks(dummy.ctx);
  const target = spawnDummy(dummy, a.x, a.y, {}, 1e9);
  target.types = [];
  target.flying = true;
  target.maxHp = referenceHp;
  target.r = referenceRadius;
  a.bossId = target.id;
  // Hold a fixed close range so area and melee are comparable to projectile builds. This is
  // sustained potential DPS: no movement/defence, no terrain/weather/type bonus or overkill.
  dummy.state.weather.current = null;
  dummy.state.players.forEach((p, i) => {
    p.x = p.prevX = a.x;
    p.y = p.prevY = a.y + 40 + i * 2;
    dummy.setInput(p.id, { moveX: 0, moveY: 0 });
  });
  for (let i = 0; i < 30 / DT; i++) {
    const hp = target.hp;
    dummy.step();
    dummy.drainEvents();
    // Ignore knockback: pin the dummy after each step, retaining real cast/status timers.
    target.x = a.x;
    target.y = a.y;
    target.speed = 0;
    target.kx = target.ky = 0;
    if (target.hp > hp) throw new Error('dummy unexpectedly healed');
  }
  return (1e9 - target.hp) / 30;
}

function encounter(
  sim: Sim,
  cell: Cell,
  seed: number,
  minute: number,
  profile: Profile,
  protectedCalibration: boolean,
): Trial {
  const dps = dummyDps(sim, cell, seed);
  const builds = sim.state.players.map(describe);
  const level = sim.state.team.level;
  sim.debugStartArena();
  const arena = sim.state.arena!;
  const boss = sim.state.enemies.find((e) => e.id === arena.bossId)!;
  const legendHp = boss.hp;
  let damageTaken = 0;
  let downs = 0;
  let removed = 0;
  let ticks = 0;
  sim.drainEvents();
  while (
    arena.phase === 'fight' &&
    ticks < Math.ceil(sim.ctx.d.game.tuning.rift.arenaTime / DT) + 2
  ) {
    pickFirst(sim);
    drive(sim);
    if (profile === 'natural') selectAttackSlot(sim);
    const hp = boss.hp;
    sim.step();
    removed += Math.max(0, hp - Math.max(0, boss.hp));
    for (const event of sim.drainEvents()) {
      if (event.type === 'player-hurt') damageTaken += event.amount;
      if (event.type === 'player-down') downs++;
    }
    ticks++;
  }
  const seconds = ticks * DT;
  return {
    kind: 'trial',
    ...cell,
    seed,
    minute,
    profile,
    calibrationProtected: protectedCalibration,
    level,
    builds,
    legendDex: boss.dex,
    shiny: boss.shiny,
    legendHp,
    legendDamage: boss.damage,
    legendShotDamage: boss.def.shotDamage ?? 0,
    won: arena.phase === 'won',
    ttk: arena.phase === 'won' ? seconds : null,
    fightSeconds: seconds,
    damageTaken,
    downs,
    hpRemoved: removed,
    fightDps: removed / seconds,
    dummyDps: dps,
  };
}

function main(): void {
  const args = new Map(
    process.argv.slice(2).map((a) => {
      const [key, ...rest] = a.replace(/^--/, '').split('=');
      return [key!, rest.join('=')];
    }),
  );
  const allowed = [
    'out',
    'minutes',
    'seeds',
    'players',
    'meta',
    'archetypes',
    'profiles',
    'progression',
    'calibrate-only',
  ];
  for (const key of args.keys())
    if (!allowed.includes(key)) throw new Error(`unknown argument --${key}`);
  const numbers = (key: string, defaults: string) =>
    (args.get(key) ?? defaults).split(',').map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --${key}: ${v}`);
      return n;
    });
  const choices = <T extends string>(key: string, defaults: readonly T[]): T[] => {
    const values = (args.get(key) ?? defaults.join(',')).split(',');
    if (values.some((v) => !defaults.includes(v as T))) throw new Error(`invalid --${key}`);
    return values as T[];
  };
  const minutes = [...new Set(numbers('minutes', '2,4,6,8,10,12,15,20'))].sort((a, b) => a - b);
  const seeds = numbers('seeds', '7,99,2026');
  const players = numbers('players', '1,2,4');
  if (players.some((n) => ![1, 2, 4].includes(n)) || seeds.some((s) => !Number.isSafeInteger(s)))
    throw new Error('players must be 1,2,4; seeds must be positive integers');
  const metas = choices<Meta>('meta', ['none', 'half', 'max']);
  const types = choices<Archetype>('archetypes', ['projectile', 'melee', 'area']);
  const profiles = choices<Profile>('profiles', ['natural', 'weak', 'typical', 'strong']);
  const progression = args.get('progression') ?? 'protected';
  if (!['protected', 'ordinary'].includes(progression)) throw new Error('invalid --progression');
  const protectedRun = progression === 'protected';
  const out = args.get('out');
  if (out) writeFileSync(out, '');
  const emit = (v: unknown) => {
    const line = JSON.stringify(v) + '\n';
    if (out) appendFileSync(out, line);
    else process.stdout.write(line);
  };
  emit({
    kind: 'metadata',
    schema: 1,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    minutes,
    seeds,
    players,
    metas,
    archetypes: types,
    profiles,
    progression,
    arenaSeconds: 120,
    dummySeconds: 30,
  });
  for (const meta of metas)
    for (const n of players)
      for (const archetype of types) {
        const cell: Cell = { meta, players: n, archetype };
        const snapshots = seeds.flatMap((seed) =>
          naturalRun(cell, seed, minutes, protectedRun, emit),
        );
        if (args.has('calibrate-only')) continue;
        for (const minute of minutes) {
          const calibration = snapshots.filter((s) => s.minute === minute);
          if (!calibration.length) {
            emit({ kind: 'skipped', ...cell, minute, reason: 'no surviving calibration runs' });
            continue;
          }
          const level = Math.round(median(calibration.map((s) => s.level)));
          for (const seed of seeds)
            for (const profile of profiles) {
              const sim = makeSim(cell, seed, true);
              sim.state.time = minute * 60;
              if (profile === 'natural') {
                const source = calibration.find((s) => s.seed === seed);
                if (!source) continue;
                sim.state.team.level = source.level;
                sim.state.players.forEach((p, i) => loadBuild(sim, p, source.builds[i]!));
              } else synthetic(sim, cell, level, profile, calibration);
              emit(encounter(sim, cell, seed, minute, profile, protectedRun));
            }
        }
        process.stderr.write(`finished ${meta}/${n}/${archetype}\n`);
      }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
