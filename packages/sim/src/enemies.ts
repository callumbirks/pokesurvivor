// Wild Pokémon (original implementation, logic only): behaviours, bosses, statuses, deaths and
// loot, plus the manager's spatial grid, separation and stragglers.
//
// Hovering Pokémon and bosses ignore terrain; the rest collide with walls and props, slow down in
// water and burn in lava.
import { DT, OUTER_RADIUS } from './constants.js';
import { activePlayers, emit, nextId, presentPlayers, seenByAny, type Ctx } from './ctx.js';
import type { PokemonType } from '@pokesurvivor/data';
import type { HitLabel } from './events.js';
import { enemyRef } from './balance.js';
import { addHazard } from './hazards.js';
import { addMomentum } from './momentum.js';
import { TAU, clamp, dist, dist2, hash2, norm } from './math.js';
import { pathDir } from './pathing.js';
import { dropPickup, dropXp } from './pickups.js';
import { spawnProjectile } from './projectiles.js';
import { rejoinPlayer, spawnCap } from './spawner.js';
import { weatherSpeedMult } from './weather.js';
import { collide, isLiquid, liquidKind, rollItem } from './world.js';
import type {
  BossAi,
  BossSkill,
  EnemyDef,
  EnemyScale,
  EnemyState,
  PlayerId,
  PlayerState,
  StatusPayload,
} from './state.js';

const CELL = 52;
/** Seconds a straggler must spend behind you out of view before it comes back ahead. */

export function pokemonName(ctx: Ctx, dex: number): string {
  return ctx.d.game.pokemonByDex.get(dex)?.name ?? `#${dex}`;
}

// ---------------------------------------------------------------- creation

/** Bosses grow to ~110 tall, in steps of 0.5 so pixels stay whole at ×2 zoom. */
function bossScale(height: number): number {
  return clamp(Math.round((110 / height) * 2) / 2, 1, 2);
}

export function createEnemy(
  ctx: Ctx,
  def: EnemyDef,
  x: number,
  y: number,
  sc: EnemyScale,
  boss = false,
): EnemyState {
  const { d, rand } = ctx;
  const body = d.body(def.dex);
  const scale = boss ? bossScale(body.height) : 1;
  const types = d.game.pokemonByDex.get(def.dex)?.types ?? [];
  const ts = types.length ? [...types] : (['normal'] as const).slice();
  const maxHp = Math.round(def.hp * sc.hp);
  return {
    id: nextId(ctx.s),
    dex: def.dex,
    def,
    x,
    y,
    r: body.radius * scale,
    height: body.height * scale,
    scale,
    boss,
    legend: false,
    shiny: false,
    golden: false,
    // Only Pokémon that float in their sprite fly over rocks and water (a Rowlet walks though it's
    // a Flying type). Bosses too, because of their size.
    flying: boss || body.hovers,
    types: ts,
    attackType: ts[0] ?? 'normal',
    behavior: def.behavior,
    hp: maxHp,
    maxHp,
    speed: def.speed * sc.speed,
    damage: def.damage * sc.damage,
    xp: def.xp,
    sc,
    slow: 0,
    slowT: 0,
    burn: 0,
    burnT: 0,
    burnTick: 0,
    poison: 0,
    poisonT: 0,
    poisonTick: 0,
    lavaTick: 0,
    kx: 0,
    ky: 0,
    touchCd: 0,
    dead: false,
    face: Math.PI / 2,
    phase: 'walk',
    pt: 0,
    dashX: 0,
    dashY: 0,
    shotCd:
      def.behavior === 'healer'
        ? rand.range(...d.game.tuning.enemyHeals.initialCooldown)
        : def.shotCooldown
          ? rand.range(0.3, def.shotCooldown)
          : 0,
    stuckT: 0,
    sideT: 0,
    side: 1,
    shield: 0,
    shieldT: 0,
    shieldCd: 0,
    healCredit: 0,
    healCd: 0,
    skillCd:
      def.behavior === 'shielder'
        ? rand.range(...d.game.tuning.enemyShields.initialCooldown)
        : rand.range(1, 4),
    minions: [],
    jump: null,
    lagT: 0,
    targetId: nearestAlive(activePlayers(ctx.s), x, y)?.id ?? null,
    transferFromId: null,
    zig: 0,
    life: null,
    losT: 0,
    los: false,
    ai: null,
    lastHitBy: null,
    burnBy: null,
    poisonBy: null,
  };
}

/** Golden hour: double XP (and sometimes coins). Not bosses or thieves. */
export function makeGolden(e: EnemyState): void {
  if (e.golden || e.boss || e.behavior === 'thief') return;
  e.golden = true;
  e.xp *= 2;
}

/** Shiny: twice the HP and five times the XP. */
export function makeShiny(e: EnemyState): void {
  e.shiny = true;
  e.maxHp *= 2;
  e.hp = e.maxHp;
  e.xp *= 5;
}

export function addEnemy(ctx: Ctx, e: EnemyState): EnemyState {
  ctx.s.enemies.push(e);
  ctx.enemyById.set(e.id, e);
  emit(ctx, {
    type: 'enemy-spawned',
    id: e.id,
    dex: e.dex,
    boss: e.boss,
    legend: e.legend,
    shiny: e.shiny,
  });
  return e;
}

// ---------------------------------------------------------------- grid

const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

export function rebuildGrid(ctx: Ctx): void {
  ctx.grid.clear();
  ctx.enemyById.clear();
  for (const e of ctx.s.enemies) {
    ctx.enemyById.set(e.id, e);
    if (e.dead) continue;
    const k = cellKey(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
    let b = ctx.grid.get(k);
    if (!b) ctx.grid.set(k, (b = []));
    b.push(e);
  }
}

/** Live enemies whose circle touches this circle. */
export function queryEnemies(ctx: Ctx, x: number, y: number, r: number): EnemyState[] {
  const out: EnemyState[] = [];
  const c0x = Math.floor((x - r) / CELL) - 1;
  const c1x = Math.floor((x + r) / CELL) + 1;
  const c0y = Math.floor((y - r) / CELL) - 1;
  const c1y = Math.floor((y + r) / CELL) + 1;
  for (let cy = c0y; cy <= c1y; cy++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const b = ctx.grid.get(cellKey(cx, cy));
      if (!b) continue;
      for (const e of b) {
        if (e.dead) continue;
        const rr = r + e.r;
        if (dist2(x, y, e.x, e.y) <= rr * rr) out.push(e);
      }
    }
  }
  return out;
}

function separate(ctx: Ctx): void {
  for (const e of ctx.s.enemies) {
    if (e.dead) continue;
    const cx = Math.floor(e.x / CELL);
    const cy = Math.floor(e.y / CELL);
    let px = 0;
    let py = 0;
    let n = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const b = ctx.grid.get(cellKey(cx + i, cy + j));
        if (!b) continue;
        for (const o of b) {
          if (o === e || o.dead) continue;
          const min = (e.r + o.r) * 0.82;
          const dx = e.x - o.x;
          const dy = e.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > min * min || d2 < 1e-4) continue;
          const d = Math.sqrt(d2);
          const f = (min - d) / min;
          px += (dx / d) * f;
          py += (dy / d) * f;
          if (++n > 6) break;
        }
      }
    }
    if (n) {
      e.x += px * 42 * DT;
      e.y += py * 42 * DT;
      if (!e.flying) collide(ctx, e);
    }
  }
}

// ---------------------------------------------------------------- damage

export interface HurtOptions {
  dirX?: number;
  dirY?: number;
  knockback?: number;
  label?: HitLabel;
  by?: PlayerId;
  /** The attack's type, for the client's damage number colour. */
  type?: PokemonType | null;
}

export function hurtEnemy(ctx: Ctx, e: EnemyState, amount: number, o: HurtOptions = {}): void {
  if (e.dead) return;
  const d = Math.max(1, Math.round(amount));
  const by = o.by ?? null;
  const moveType = o.type ?? null;
  // The shield absorbs first.
  if (e.shield > 0) {
    const a = Math.min(e.shield, d);
    e.shield -= a;
    if (a >= d) {
      emit(ctx, {
        type: 'enemy-hurt',
        id: e.id,
        x: e.x,
        y: e.y,
        amount: d,
        label: null,
        shielded: true,
        byPlayer: by,
        moveType,
      });
      return;
    }
    amount = d - a;
  }
  const hpDamage = Math.max(1, Math.round(amount));
  const healing = ctx.d.game.tuning.enemyHeals;
  // Count HP damage only, including partial shield overflow. Each point can fund healing once;
  // consuming this credit stops overlapping healers (and shield/heal packs) from infinite regen.
  e.healCredit = Math.min(
    e.maxHp * healing.maxHpFraction,
    e.healCredit + Math.min(e.hp, hpDamage) * healing.damageFraction,
  );
  e.hp -= hpDamage;
  emit(ctx, {
    type: 'enemy-hurt',
    id: e.id,
    x: e.x,
    y: e.y,
    amount: d,
    label: o.label ?? null,
    shielded: false,
    byPlayer: by,
    moveType,
  });
  const knock = o.knockback ?? 0;
  if (knock > 0 && !e.boss) {
    const [nx, ny] = norm(o.dirX ?? 0, o.dirY ?? 0);
    e.kx += nx * knock;
    e.ky += ny * knock;
  }
  if (by) e.lastHitBy = by;
  if (e.hp <= 0) killEnemy(ctx, e);
}

/** `by`: the player whose attack applied it (its ticks, and a kill by them, are credited to them). */
export function applyStatus(e: EnemyState, s: StatusPayload, by: PlayerId | null = null): void {
  if (e.dead) return;
  if (s.burn) {
    e.burn = Math.min(8, e.burn + s.burn);
    e.burnT = 3;
    e.burnBy = by;
  }
  if (s.poison) {
    e.poison = Math.min(8, e.poison + s.poison);
    e.poisonT = 4;
    e.poisonBy = by;
  }
  if (s.slow) {
    e.slow = Math.max(e.slow, s.slow);
    e.slowT = Math.max(e.slowT, 1.2);
  }
}

/** Drops loot and marks it dead; the manager counts and removes it on its next update. */
export function killEnemy(ctx: Ctx, e: EnemyState): void {
  if (e.dead) return;
  const { rand } = ctx;
  e.dead = true;
  e.hp = Math.min(e.hp, 0);
  emit(ctx, {
    type: 'enemy-died',
    id: e.id,
    dex: e.dex,
    x: e.x,
    y: e.y,
    boss: e.boss,
    legend: e.legend,
    shiny: e.shiny,
  });
  if (e.boss) {
    for (let i = 0; i < 10; i++) {
      dropPickup(ctx, 'coin', e.x + rand.range(-40, 40), e.y + rand.range(-30, 30), 5);
    }
    // Bosses always drop a held item.
    dropPickup(ctx, 'item', e.x - 26, e.y - 10, 0, rollItem(ctx));
  }
  dropXp(ctx, e.x, e.y, e.xp, e.boss, e.legend);
  if (e.golden && rand() < 0.35) dropPickup(ctx, 'coin', e.x + 6, e.y - 4, 3);
  // Treasure thieves: Meowth drops coins; Gholdengo a ×10 ticket.
  if (e.behavior === 'thief') {
    const ticket = e.def.loot === 'ticket10';
    for (let i = 0; i < (ticket ? 6 : 20); i++) {
      dropPickup(ctx, 'coin', e.x + rand.range(-36, 36), e.y + rand.range(-26, 26), 5);
    }
    if (ticket) dropPickup(ctx, 'ticket10', e.x, e.y - 12, 1);
  }
  // The rift legendary: loose tickets and coins (on top of a boss's loot; the ×10 is in dropXp).
  if (e.legend) {
    const R = ctx.d.game.tuning.rift;
    for (let i = 0; i < R.rewardTickets; i++) {
      dropPickup(ctx, 'ticket', e.x + rand.range(-30, 30), e.y + rand.range(-20, 20), 1);
    }
    for (let i = 0; i < R.rewardCoinDrops; i++) {
      dropPickup(
        ctx,
        'coin',
        e.x + rand.range(-50, 50),
        e.y + rand.range(-35, 35),
        R.rewardCoinValue,
      );
    }
  }
  if (e.shiny) {
    ctx.s.team.shinies.push(e.dex);
    emit(ctx, { type: 'shiny-caught', dex: e.dex });
    emit(ctx, {
      type: 'say',
      key: 'hud.youGotAShiny',
      params: { 0: pokemonName(ctx, e.dex) },
      seconds: 4,
    });
  }
}

// ---------------------------------------------------------------- the manager

function nearestAlive(players: PlayerState[], x: number, y: number): PlayerState | null {
  let best: PlayerState | null = null;
  let bd = Infinity;
  for (const p of players) {
    if (p.dead) continue;
    const d = dist2(x, y, p.x, p.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

export function updateEnemies(ctx: Ctx): void {
  const { s } = ctx;
  const players = activePlayers(s);
  const fallback = players[0] ?? presentPlayers(s)[0];
  if (!fallback) return;
  const tuning = ctx.d.game.tuning.stragglers;
  const available = new Set(players.filter((p) => !p.dead).map((p) => p.id));
  for (const p of players) {
    p.relocationTokens = Math.min(
      tuning.burst,
      p.relocationTokens + tuning.relocationsPerSecond * DT,
    );
  }
  rebuildGrid(ctx);
  // (Minions summoned during the loop are appended and updated this tick too, as in legacy.)
  for (const e of s.enemies) {
    if (e.dead) continue;
    const target = nearestAlive(players, e.x, e.y) ?? fallback;
    if (e.targetId !== null && !available.has(e.targetId)) e.transferFromId = e.targetId;
    if (e.transferFromId !== null && available.has(e.transferFromId)) e.transferFromId = null;
    e.targetId = target.id;
    updateEnemy(ctx, e, target);
  }
  separate(ctx);
  const list = s.enemies;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e) continue;
    if (e.dead) {
      countKill(ctx, e);
      list.splice(i, 1);
      ctx.enemyById.delete(e.id);
      continue;
    }
    const near = nearestAlive(players, e.x, e.y) ?? fallback;
    // A treasure thief gets away if you don't catch it in time.
    if (e.life !== null && (e.life -= DT) <= 0) {
      emit(ctx, {
        type: 'say',
        key: 'hud.gotAway',
        params: { 0: pokemonName(ctx, e.dex) },
        seconds: 2.4,
      });
      removeEnemy(ctx, i);
      continue;
    }
    if (e.boss || e.shiny || e.legend) continue;
    // An unseen train keeps walking for the configured grace, including very distant enemies.
    // Seeing any teammate resets the timer; distance alone never bypasses the grace.
    const d2 = dist2(e.x, e.y, near.x, near.y);
    const R = OUTER_RADIUS + 40;
    const unseen = d2 > R * R && !seenByAny(s, e.x, e.y, 60, true);
    if (d2 <= R * R) e.transferFromId = null;
    if (unseen) e.lagT += DT;
    else e.lagT = 0;
    if (unseen && e.lagT > tuning.unseenSeconds) {
      if (e.transferFromId !== null && near.relocationTokens < 1 - 1e-9) continue;
      if (!rejoinPlayer(ctx, e, near)) continue;
      if (e.transferFromId !== null) near.relocationTokens = Math.max(0, near.relocationTokens - 1);
      e.transferFromId = null;
      e.targetId = near.id;
      e.lagT = 0;
    }
  }
}

function removeEnemy(ctx: Ctx, i: number): void {
  const [e] = ctx.s.enemies.splice(i, 1);
  if (!e) return;
  ctx.enemyById.delete(e.id);
  emit(ctx, { type: 'enemy-removed', id: e.id });
}

function countKill(ctx: Ctx, e: EnemyState): void {
  const { s } = ctx;
  s.team.kills++;
  if (e.boss) s.team.bosses++;
  const killer = e.lastHitBy ? s.players.find((p) => p.id === e.lastHitBy) : undefined;
  if (killer) {
    killer.stats.lastHits++;
    addMomentum(ctx, killer);
  }
  // Everyone in the run gets the defeat for their missions (as legacy co-op did).
  for (const p of presentPlayers(s)) {
    const pr = p.stats.progress;
    pr.defeats++;
    for (const t of e.types) pr.defeatsByType[t] = (pr.defeatsByType[t] ?? 0) + 1;
    if (e.boss) pr.bossDefeats++;
    if (e.legend) pr.legendariesDefeated.push(e.dex);
  }
  emit(ctx, {
    type: 'progress',
    event: 'defeat',
    playerId: null,
    data: { types: e.types, boss: e.boss, legend: e.legend ? e.dex : 0 },
  });
}

// ---------------------------------------------------------------- one enemy

const KEEPS_DISTANCE = new Set(['ranged', 'fan', 'beamer', 'zoner', 'healer', 'summoner']);
const keepsDistance = (e: EnemyState) => KEEPS_DISTANCE.has(e.behavior);

function updateEnemy(ctx: Ctx, e: EnemyState, pl: PlayerState): void {
  const dt = DT;
  const { rand } = ctx;
  if (e.touchCd > 0) e.touchCd -= dt;
  if (e.losT > 0) e.losT -= dt;
  // Before behaviour early returns (e.g. thieves), so every recipient's shield expires.
  e.shieldCd = Math.max(0, e.shieldCd - dt);
  e.healCd = Math.max(0, e.healCd - dt);
  if (e.shieldT > 0) {
    e.shieldT = Math.max(0, e.shieldT - dt);
    if (e.shieldT === 0) e.shield = 0;
  }

  // --- statuses ---
  if (e.slowT > 0) {
    e.slowT -= dt;
    if (e.slowT <= 0) e.slow = 0;
  }
  if (e.burn > 0) {
    e.burnT -= dt;
    e.burnTick -= dt;
    if (e.burnTick <= 0) {
      e.burnTick = 0.5;
      hurtEnemy(ctx, e, 1.6 * e.burn * (1 + ctx.s.team.level * 0.06), {
        type: 'fire',
        ...(e.burnBy ? { by: e.burnBy } : {}),
      });
    }
    if (e.burnT <= 0) e.burn = 0;
  }
  if (e.poison > 0) {
    e.poisonT -= dt;
    e.poisonTick -= dt;
    if (e.poisonTick <= 0) {
      e.poisonTick = 0.6;
      const factor = e.boss || e.legend ? ctx.d.game.tuning.poison.bossFactor : 1;
      hurtEnemy(ctx, e, e.maxHp * 0.012 * e.poison * factor + 1, {
        type: 'poison',
        ...(e.poisonBy ? { by: e.poisonBy } : {}),
      });
    }
    if (e.poisonT <= 0) e.poison = 0;
  }
  if (e.dead) return;

  // --- terrain (the rift legendary is at home: its arena doesn't affect it) ---
  let terrainMul = 1;
  if (!e.flying && !e.legend && isLiquid(ctx, e.x, e.y)) {
    const le = ctx.d.liquidEffect(liquidKind(ctx), e.types);
    if (le.damage) {
      e.lavaTick -= dt;
      if (e.lavaTick <= 0) {
        e.lavaTick = le.every ?? 0.5;
        hurtEnemy(ctx, e, 6 + e.maxHp * 0.04);
      }
      if (e.dead) return;
    } else if (le.slow) terrainMul = le.slow < 0.5 ? 0.45 : 0.55;
  }

  const spd = e.speed * (1 - e.slow) * terrainMul * weatherSpeedMult(ctx, e.types);
  let [dx, dy] = norm(pl.x - e.x, pl.y - e.y);
  const d = dist(e.x, e.y, pl.x, pl.y);

  // Treasure thief: runs away from you (zig-zagging) as soon as you get close.
  if (e.behavior === 'thief') {
    e.zig += dt;
    const near = d < 300;
    const a = Math.atan2(-dy, -dx) + Math.sin(e.zig * 2.2) * 0.7;
    const k = near ? 1 : 0.35;
    const ox = e.x;
    const oy = e.y;
    e.x += (Math.cos(a) * spd * k + e.kx) * dt;
    e.y += (Math.sin(a) * spd * k + e.ky) * dt;
    e.kx *= Math.pow(0.0015, dt);
    e.ky *= Math.pow(0.0015, dt);
    if (collide(ctx, e) && Math.hypot(e.x - ox, e.y - oy) < spd * k * dt * 0.3) e.zig += 1.4;
    e.face = a;
    return;
  }
  // Runner: heads to where you WILL be (cuts off players who only flee).
  if (e.behavior === 'runner') {
    const lead = clamp(d / Math.max(60, spd), 0, 1.4);
    [dx, dy] = norm(pl.x + pl.smoothVx * lead - e.x, pl.y + pl.smoothVy * lead - e.y);
  }

  // --- personality (shields, jumps, explosions) ---
  if (e.jump) {
    updateJump(ctx, e);
    return;
  }
  if (e.behavior === 'bomber' && e.phase === 'fuse') {
    e.pt -= dt;
    if (e.pt <= 0) {
      e.hp = 0;
      killEnemy(ctx, e);
    }
    return;
  }
  if (e.behavior === 'bomber' && d < e.r + pl.r + 26) {
    startFuse(ctx, e);
    return;
  }
  if (e.behavior === 'shielder' || e.behavior === 'jumper') {
    e.skillCd -= dt;
    if (e.skillCd <= 0) {
      if (e.behavior === 'shielder') {
        e.skillCd = ctx.d.game.tuning.enemyShields.cooldown;
        castShields(ctx, e);
      } else if (d < 250) {
        e.skillCd = rand.range(5, 7);
        startJump(ctx, e, pl);
        return;
      } else e.skillCd = 0.5;
    }
  }

  // Stuck against something for a while: go around one side.
  if (e.sideT > 0) {
    e.sideT -= dt;
    const a = Math.atan2(dy, dx) + e.side * 1.25;
    dx = Math.cos(a);
    dy = Math.sin(a);
  }

  // Path around obstacles (walkers only).
  if (!e.flying && e.phase !== 'dash' && e.sideT <= 0) {
    const pd = pathDir(ctx, e, pl);
    if (pd && !(keepsDistance(e) && d < (e.def.range || 200) * 0.82)) [dx, dy] = pd;
  }

  let vx = dx * spd;
  let vy = dy * spd;

  if (e.boss) {
    [vx, vy] = bossMove(ctx, e, pl, d, dx, dy, spd);
  } else if (e.behavior === 'charger') {
    e.pt -= dt;
    if (e.phase === 'walk') {
      if (d < 200 && e.pt <= 0) {
        e.phase = 'aim';
        e.pt = 0.55;
        emit(ctx, { type: 'enemy-action', id: e.id, action: 'charge' });
      }
    } else if (e.phase === 'aim') {
      vx = vy = 0;
      if (e.pt <= 0) {
        e.phase = 'dash';
        e.pt = 0.42;
        e.dashX = dx;
        e.dashY = dy;
        emit(ctx, { type: 'enemy-action', id: e.id, action: 'dash' });
      }
    } else if (e.phase === 'dash') {
      vx = e.dashX * spd * 3.4;
      vy = e.dashY * spd * 3.4;
      if (e.pt <= 0) {
        e.phase = 'walk';
        e.pt = 1.1;
      }
    }
  } else if (keepsDistance(e)) {
    const range = e.def.range || 200;
    const keep = range * 0.82;
    // Straight at you (not the path) to back off.
    const [ddx, ddy] = norm(pl.x - e.x, pl.y - e.y);
    if (d < keep * 0.75) {
      vx = -ddx * spd * 0.8;
      vy = -ddy * spd * 0.8;
    } else if (d < keep) {
      vx *= 0.1;
      vy *= 0.1;
    }
    e.shotCd -= dt;
    if (e.shotCd <= 0 && d < range) {
      e.shotCd =
        e.behavior === 'healer' ? ctx.d.game.tuning.enemyHeals.cooldown : e.def.shotCooldown || 2;
      special(ctx, e, pl, ddx, ddy);
    }
  }

  // --- integration ---
  const ox = e.x;
  const oy = e.y;
  e.x += e.kx * dt;
  e.y += e.ky * dt;
  e.kx *= Math.pow(0.0015, dt);
  e.ky *= Math.pow(0.0015, dt);
  e.x += vx * dt;
  e.y += vy * dt;

  if (!e.flying && collide(ctx, e)) {
    // Moved much less than it wanted?
    const want = Math.hypot(vx, vy) * dt;
    const got = Math.hypot(e.x - ox, e.y - oy);
    if (want > 0.5 && got < want * 0.35) {
      e.stuckT += dt;
      if (e.stuckT > 0.35 && e.sideT <= 0) {
        e.sideT = 0.7;
        e.stuckT = 0;
        e.side = rand() < 0.5 ? -1 : 1;
      }
    } else e.stuckT = 0;
  }

  const moving = Math.abs(vx) + Math.abs(vy) > 2;
  e.face =
    e.phase === 'dash'
      ? Math.atan2(e.dashY, e.dashX)
      : moving
        ? Math.atan2(vy, vx)
        : Math.atan2(pl.y - e.y, pl.x - e.x);
}

// ---------------------------------------------------------------- attacks and skills

/** Damage of this enemy's shots (scaled like its contact damage). */
const shotDamage = (e: EnemyState) =>
  (e.def.shotDamage || 10) * (e.def.damage ? e.damage / e.def.damage : 1);

/** A normal enemy shot (one, or several in a fan). */
function shoot(ctx: Ctx, e: EnemyState, ax: number, ay: number, spread = 0, n = 1, k = 1) {
  const sp = 190;
  const base = Math.atan2(ay, ax);
  for (let i = 0; i < n; i++) {
    const a = base + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread);
    spawnProjectile(ctx, {
      friendly: false,
      regularHit: e.regularHit,
      by: enemyRef(e),
      type: e.attackType,
      x: e.x,
      y: e.y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      damage: shotDamage(e) * k,
      r: 7,
      life: 2.4,
    });
  }
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'shoot' });
}

/** What each ranged personality does when its cooldown is up. */
function special(ctx: Ctx, e: EnemyState, pl: PlayerState, dx: number, dy: number): void {
  const { rand } = ctx;
  switch (e.behavior) {
    case 'fan': {
      const n = e.def.fanCount || 5;
      shoot(ctx, e, dx, dy, n === 3 ? 0.6 : 0.9, n, 0.65);
      return;
    }
    case 'beamer':
      // Beam with a warning: the strip shows on the ground first.
      addHazard(ctx, {
        by: enemyRef(e),
        kind: 'beam',
        x: e.x,
        y: e.y,
        angle: Math.atan2(dy, dx),
        len: 360,
        w: 22,
        delay: 1.0,
        damage: shotDamage(e) * 1.05,
        type: e.attackType,
      });
      emit(ctx, { type: 'enemy-action', id: e.id, action: 'charge' });
      return;
    case 'zoner': {
      const n = rand.int(1, e.def.zones || 3);
      for (let i = 0; i < n; i++) {
        addHazard(ctx, {
          by: enemyRef(e),
          kind: 'zone',
          x: pl.x + (i ? rand.range(-70, 70) : 0),
          y: pl.y + (i ? rand.range(-55, 55) : 0),
          r: 44,
          delay: 1.2,
          damage: shotDamage(e) * 0.95,
          type: e.attackType,
        });
      }
      emit(ctx, { type: 'enemy-action', id: e.id, action: 'shoot' });
      return;
    }
    case 'healer':
      healAround(ctx, e);
      return;
    case 'summoner':
      summon(ctx, e);
      return;
    default:
      shoot(ctx, e, dx, dy);
  }
}

/** Restore a limited share of HP damage. All healers share the recipient's credit and cooldown. */
function healAround(ctx: Ctx, e: EnemyState): void {
  const tuning = ctx.d.game.tuning.enemyHeals;
  const targets = queryEnemies(ctx, e.x, e.y, tuning.radius)
    .filter(
      (o) =>
        !o.dead &&
        o.hp < o.maxHp &&
        o.healCredit > 0 &&
        o.healCd <= 0 &&
        (tuning.affectsShielded || o.shield <= 0) &&
        (tuning.affectsBosses || (!o.boss && !o.legend)),
    )
    .sort((a, b) => dist2(a.x, a.y, e.x, e.y) - dist2(b.x, b.y, e.x, e.y) || a.id - b.id)
    .slice(0, tuning.maxTargets);
  for (const o of targets) {
    const amount = Math.min(o.maxHp - o.hp, o.maxHp * tuning.maxHpFraction, o.healCredit);
    o.hp += amount;
    o.healCredit = Math.max(0, o.healCredit - amount);
    o.healCd = tuning.recipientCooldown;
    emit(ctx, { type: 'enemy-healed', id: o.id, x: o.x, y: o.y, amount });
  }
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'heal' });
}

function castShields(ctx: Ctx, e: EnemyState): void {
  const tuning = ctx.d.game.tuning.enemyShields;
  const near = queryEnemies(ctx, e.x, e.y, tuning.radius)
    .filter(
      (o) =>
        !o.dead &&
        (tuning.affectsBosses || (!o.boss && !o.legend)) &&
        o.shield <= 0 &&
        o.shieldCd <= 0,
    )
    .sort((a, b) => dist2(a.x, a.y, e.x, e.y) - dist2(b.x, b.y, e.x, e.y) || a.id - b.id)
    .slice(0, tuning.maxTargets);
  for (const o of near) {
    // A live shield is never topped up or extended. The recipient cooldown also prevents a
    // second caster from replacing a broken/expired shield immediately.
    o.shield = o.maxHp * tuning.maxHpFraction;
    o.shieldT = tuning.duration;
    o.shieldCd = tuning.reapplyCooldown;
  }
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'shield' });
}

function summon(ctx: Ctx, e: EnemyState): void {
  e.minions = e.minions.filter((id) => {
    const m = ctx.enemyById.get(id);
    return m && !m.dead;
  });
  // Respects the general enemy cap (with a small margin).
  if (e.minions.length >= 4 || ctx.s.enemies.length > spawnCap(ctx) + 15) return;
  const def: EnemyDef = {
    dex: e.def.minion ?? e.dex,
    behavior: 'chase',
    hp: Math.round(e.def.hp * 0.35),
    speed: Math.round(e.def.speed * 1.1),
    damage: Math.round(e.def.damage * 0.6),
    xp: Math.max(1, Math.round(e.def.xp * 0.25)),
  };
  for (let i = 0; i < 2; i++) {
    const a = ctx.rand() * TAU;
    const m = createEnemy(ctx, def, e.x + Math.cos(a) * 30, e.y + Math.sin(a) * 22, e.sc);
    m.regularHit = e.regularHit;
    addEnemy(ctx, m);
    e.minions.push(m.id);
  }
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'summon' });
}

function startFuse(ctx: Ctx, e: EnemyState): void {
  e.phase = 'fuse';
  e.pt = 1.0;
  addHazard(ctx, {
    by: enemyRef(e),
    kind: 'zone',
    x: e.x,
    y: e.y,
    r: 62,
    delay: 1.0,
    damage: e.damage * 1.4,
    type: e.attackType,
  });
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'fuse' });
}

function startJump(ctx: Ctx, e: EnemyState, pl: PlayerState): void {
  e.jump = { sx: e.x, sy: e.y, tx: pl.x, ty: pl.y, t: -0.45, dur: 0.6 };
  addHazard(ctx, {
    by: enemyRef(e),
    kind: 'zone',
    x: pl.x,
    y: pl.y,
    r: 50,
    delay: 1.05,
    damage: e.damage * 1.2,
    type: e.attackType,
  });
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'jump' });
}

/** Jump: crouches, flies in an arc and lands where you were. */
function updateJump(ctx: Ctx, e: EnemyState): void {
  const j = e.jump;
  if (!j) return;
  j.t += DT;
  if (j.t < 0) return;
  const k = Math.min(1, j.t / j.dur);
  e.x = j.sx + (j.tx - j.sx) * k;
  e.y = j.sy + (j.ty - j.sy) * k;
  e.face = Math.atan2(j.ty - j.sy, j.tx - j.sx);
  if (k >= 1) {
    e.jump = null;
    if (!e.flying) collide(ctx, e);
    emit(ctx, { type: 'enemy-action', id: e.id, action: 'land' });
  }
}

// ---------------------------------------------------------------- bosses
// Every boss has 4 attacks: 2 close (Slam always + Dash or Leap) and 2 ranged by type. It
// alternates between rushing you and fighting from afar, so shooters also close in and brawlers
// also shoot. Everything is telegraphed. Below half HP it's enraged: faster, shorter waits, and
// sometimes chains two attacks.

function bossInit(ctx: Ctx, e: EnemyState): BossAi {
  const T = e.types;
  const has = (...xs: string[]) => xs.some((x) => T.includes(x as never));
  const melee: BossSkill[] = ['slam', hash2(e.dex, 3, 7) < 0.5 ? 'dash' : 'leap'];
  const pref: BossSkill = has('fire', 'ground', 'poison', 'rock', 'grass')
    ? 'rain'
    : has('electric', 'psychic', 'dragon', 'ice', 'steel')
      ? 'beam'
      : has('fairy', 'ghost', 'water', 'flying')
        ? 'nova'
        : 'volley';
  const others = (['rain', 'beam', 'nova', 'volley'] as const).filter((x) => x !== pref);
  const second = others[Math.floor(hash2(e.dex, 5, 9) * 3) % 3] ?? 'volley';
  const far = e.behavior === 'ranged';
  return {
    melee,
    ranged: [pref, second],
    farLike: far ? 0.65 : 0.35,
    mode: far ? 'far' : 'close',
    modeT: ctx.rand.range(6, 8),
    cd: 1.6,
    cast: null,
    fury: false,
    side: ctx.rand() < 0.5 ? -1 : 1,
  };
}

function bossMove(
  ctx: Ctx,
  e: EnemyState,
  pl: PlayerState,
  d: number,
  dx: number,
  dy: number,
  spd: number,
): [number, number] {
  const { rand } = ctx;
  const ai = (e.ai ??= bossInit(ctx, e));
  if (!ai.fury && e.hp < e.maxHp * 0.5) enrage(ctx, e, ai);
  const k = ai.fury ? 1.25 : 1;
  if (ai.cast) return bossCast(ctx, e, ai, pl);
  ai.modeT -= DT;
  ai.cd -= DT * k;
  // Always alternates: longer (7–9 s) at its favourite range than at the other (4–5 s).
  if (ai.modeT <= 0) {
    ai.mode = ai.mode === 'far' ? 'close' : 'far';
    ai.modeT = (ai.mode === 'far') === ai.farLike > 0.5 ? rand.range(7, 9) : rand.range(4, 5);
    ai.side = -ai.side;
  }
  let vx = dx * spd * k * 1.1;
  let vy = dy * spd * k * 1.1;
  const [ddx, ddy] = norm(pl.x - e.x, pl.y - e.y);
  if (ai.mode === 'far') {
    if (d < 170) {
      vx = -ddx * spd;
      vy = -ddy * spd;
    } else if (d < 300) {
      vx = -ddy * spd * 0.55 * ai.side; // circles you
      vy = ddx * spd * 0.55 * ai.side;
    }
  }
  if (ai.cd <= 0) {
    let id: BossSkill | null;
    if (ai.mode === 'close') {
      const ok = ai.melee.filter((m) => (m === 'slam' ? d < 125 : d < 320));
      // Now and then it shoots even up close.
      id = ok.length && rand() < 0.8 ? rand.pick(ok) : d < 480 ? rand.pick(ai.ranged) : null;
    } else {
      id = d < 115 ? 'slam' : d < 430 ? rand.pick(ai.ranged) : null;
    }
    if (id) bossStart(ctx, e, ai, id, pl);
  }
  return [vx, vy];
}

function enrage(ctx: Ctx, e: EnemyState, ai: BossAi): void {
  ai.fury = true;
  e.speed *= 1.15;
  emit(ctx, {
    type: 'say',
    key: 'hud.isEnraged',
    params: { 0: pokemonName(ctx, e.dex) },
    seconds: 2.4,
  });
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'enrage' });
}

function bossStart(ctx: Ctx, e: EnemyState, ai: BossAi, id: BossSkill, pl: PlayerState): void {
  const { rand } = ctx;
  const f = ai.fury ? 0.8 : 1;
  const type = e.attackType;
  const angle = Math.atan2(pl.y - e.y, pl.x - e.x);
  const c = (ai.cast = {
    id,
    t: 0,
    wind: 0.6 * f,
    after: 0.35,
    angle,
    len: 0,
    dur: 0,
    go: false,
    fired: false,
  });
  emit(ctx, { type: 'enemy-action', id: e.id, action: 'charge', skill: id });
  switch (id) {
    case 'slam': // shockwave around it
      c.wind = 0.85 * f;
      addHazard(ctx, {
        by: enemyRef(e),
        kind: 'zone',
        x: e.x,
        y: e.y,
        r: 96 + e.r,
        delay: c.wind,
        damage: e.damage * 1.3,
        type,
      });
      break;
    case 'dash': // straight charge
      c.wind = 0.75 * f;
      c.len = 330;
      c.dur = 0.32;
      addHazard(ctx, {
        by: enemyRef(e),
        kind: 'beam',
        x: e.x,
        y: e.y,
        angle,
        len: c.len + e.r,
        w: e.r * 2 + 16,
        delay: c.wind + c.dur,
        damage: e.damage * 1.2,
        type,
      });
      break;
    case 'leap': // jumps onto you
      e.jump = { sx: e.x, sy: e.y, tx: pl.x, ty: pl.y, t: -0.5 * f, dur: 0.65 };
      addHazard(ctx, {
        by: enemyRef(e),
        kind: 'zone',
        x: pl.x,
        y: pl.y,
        r: 82,
        delay: 0.5 * f + 0.65,
        damage: e.damage * 1.25,
        type,
      });
      ai.cast = null;
      ai.cd = rand.range(1.4, 2) + 0.6;
      break;
    case 'rain': {
      // zones falling around you
      const n = ai.fury ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const a = i ? rand() * TAU : 0;
        const dd = i ? rand.range(40, 120) : 0;
        addHazard(ctx, {
          by: enemyRef(e),
          kind: 'zone',
          x: pl.x + Math.cos(a) * dd,
          y: pl.y + Math.sin(a) * dd * 0.8,
          r: 50,
          delay: 1.05 + i * 0.12,
          damage: shotDamage(e) * 1.15,
          type,
        });
      }
      c.wind = 0.5;
      break;
    }
    case 'beam': {
      // beams in a fan
      const n = ai.fury ? 5 : 3;
      const sp = ai.fury ? 0.42 : 0.5;
      for (let i = 0; i < n; i++) {
        addHazard(ctx, {
          by: enemyRef(e),
          kind: 'beam',
          x: e.x,
          y: e.y,
          angle: angle + (i - (n - 1) / 2) * sp,
          len: 400,
          w: 26,
          delay: 1.0,
          damage: shotDamage(e) * 1.2,
          type,
        });
      }
      c.wind = 1.0;
      c.after = 0.25;
      break;
    }
    case 'volley': // fan of shots
    case 'nova': // ring of shots
      c.wind = (id === 'nova' ? 0.7 : 0.5) * f;
      break;
  }
}

function bossCast(ctx: Ctx, e: EnemyState, ai: BossAi, pl: PlayerState): [number, number] {
  const c = ai.cast;
  if (!c) return [0, 0];
  c.t += DT;
  if (c.id === 'dash' && c.t >= c.wind) {
    c.go = true;
    if (c.t >= c.wind + c.dur) return bossEnd(ctx, ai);
    const sp = c.len / c.dur;
    return [Math.cos(c.angle) * sp, Math.sin(c.angle) * sp];
  }
  if (c.t >= c.wind && !c.fired) {
    c.fired = true;
    const [ax, ay] = norm(pl.x - e.x, pl.y - e.y);
    if (c.id === 'volley') shoot(ctx, e, ax, ay, 1.1, ai.fury ? 9 : 7, 0.8);
    else if (c.id === 'nova') {
      const n = ai.fury ? 18 : 14;
      shoot(ctx, e, ax, ay, (TAU * (n - 1)) / n, n, 0.7);
    } else if (c.id === 'slam')
      emit(ctx, { type: 'enemy-action', id: e.id, action: 'strike', skill: 'slam' });
  }
  if (c.t >= c.wind + c.after) return bossEnd(ctx, ai);
  return [0, 0];
}

function bossEnd(ctx: Ctx, ai: BossAi): [number, number] {
  ai.cast = null;
  ai.cd = ctx.rand.range(1.3, 2.0);
  if (ai.fury && ctx.rand() < 0.35) ai.cd = 0.3; // chains another
  return [0, 0];
}
