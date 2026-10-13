// The players' Pokémon (legacy entities/player.js, logic only): stats, movement with collisions,
// liquids, auto-aim, damage, healing, going down and being revived.
import { emptyRunProgress } from '@pokesurvivor/protocol';
import { DT, TILE } from './constants.js';
import { activePlayers, emit, type Ctx } from './ctx.js';
import { clamp, damp, dist, dist2 } from './math.js';
import { activeGroup, addMove, setActive } from './moves.js';
import { clearOrbs } from './projectiles.js';
import { weatherDamageMult, weatherSpeedMult } from './weather.js';
import { collide, isLiquid, liquidKind, nearestBreakable } from './world.js';
import type { HitLabel } from './events.js';
import type { BuffStat, EnemyState, PlayerId, PlayerState } from './state.js';

/** What a player brings into a run. */
export interface PlayerConfig {
  id: PlayerId;
  dex: number;
  /** Plays the shiny form (only if that Pokémon has shiny sprites). */
  shiny?: boolean;
  /** Permanent upgrade levels for this Pokémon, by upgrade id (see upgrades.json). */
  upgrades?: Readonly<Record<string, number>>;
  /** Moves never offered ("Ban" upgrade); only the first `ban` level's worth are used. */
  bannedMoves?: readonly string[];
  /** Preferred slot per move ("Shortcuts"): `moveBindings[slot] = moveId`. */
  moveBindings?: readonly (string | null)[];
  /** Dex numbers of the legendaries this player has beaten (unbeaten ones come up more in rifts). */
  legendsBeaten?: readonly number[];
}

/** Seconds a teammate must stand next to you to revive you. */
export const REVIVE_SECONDS = 3;
/** How close they must stand. */
export const REVIVE_RANGE = 56;
const BASE_MAGNET = 78;

const newBuff = () => ({ n: 0, t: 0, amount: 0 });

export function createPlayer(
  ctx: Ctx,
  cfg: PlayerConfig,
  index: number,
  count: number,
): PlayerState {
  const { d } = ctx;
  const mon = d.game.pokemonByDex.get(cfg.dex);
  if (!mon) throw new Error(`unknown Pokémon ${cfg.dex}`);
  const body = d.body(cfg.dex);
  const perks = d.perks(cfg.upgrades ?? {});
  // Side by side at the centre of the starting clearing.
  const x = (index - (count - 1) / 2) * 34;
  const p: PlayerState = {
    id: cfg.id,
    dex: cfg.dex,
    shiny: !!cfg.shiny && body.shiny,
    types: [...mon.types],
    index,
    connected: true,
    left: false,
    input: { moveX: 0, moveY: 0, slot: null },
    x,
    y: 0,
    r: body.radius,
    vx: 0,
    vy: 0,
    smoothVx: 0,
    smoothVy: 0,
    prevX: x,
    prevY: 0,
    walking: false,
    moveAngle: Math.PI / 2,
    aim: Math.PI / 2,
    target: null,
    hp: mon.hp + perks.hp,
    maxHp: mon.hp + perks.hp,
    baseSpeed: mon.speed,
    baseAttack: mon.attack,
    attackMul: perks.attackMul,
    speedMul: perks.speedMul,
    cooldownMul: perks.cooldownMul,
    damageReduction: perks.damageReduction,
    regen: perks.regen,
    magnet: BASE_MAGNET * perks.magnetMul,
    xpMul: perks.xpMul,
    coinMul: perks.coinMul,
    critChance: perks.crit,
    buffs: { attack: newBuff(), speed: newBuff(), defense: newBuff(), regen: newBuff() },
    moves: [],
    slots: [],
    active: 0,
    maxSlots: d.game.levelUp.maxMoveSlots,
    bonds: 0,
    banned: (cfg.bannedMoves ?? []).slice(0, perks.bans),
    legendsBeaten: [...(cfg.legendsBeaten ?? [])],
    bind: {},
    rerollsUsed: 0,
    rerollBonus: perks.rerolls,
    statsTaken: {},
    item: null,
    itemRegen: 0,
    sashAt: null,
    bellHeal: 0,
    attackingUntil: 0,
    invuln: 0,
    slowT: 0,
    power: null,
    springHeal: 0,
    inLiquid: false,
    lavaTick: 0,
    dead: false,
    reviveT: 0,
    orbCastT: 0,
    lastPatchId: null,
    stats: {
      damageDealt: 0,
      lastHits: 0,
      timesDown: 0,
      revivesGiven: 0,
      progress: { ...emptyRunProgress(), defeatsByType: {}, defeats: 0, bossDefeats: 0 },
    },
  };
  (cfg.moveBindings ?? []).forEach((id, i) => {
    if (id) p.bind[id] = i;
  });
  addMove(ctx, p, d.startingMove(cfg.dex), true);
  // "Repertoire" upgrade: a second, random attacking move.
  if (perks.startMoves >= 2) {
    const pool = d
      .movePool(p.types)
      .filter((id) => !hasMove(p, id) && !p.banned.includes(id) && d.move(id).kind !== 'buff');
    if (pool.length) addMove(ctx, p, ctx.rand.pick(pool), true);
    setActive(ctx, p, 0, true);
  }
  return p;
}

export const hasMove = (p: PlayerState, id: string): boolean => p.moves.some((m) => m.id === id);

// ---------------------------------------------------------------- effective stats

export const attackOf = (p: PlayerState): number =>
  p.baseAttack * p.attackMul * (1 + p.buffs.attack.n * p.buffs.attack.amount);

export function speedOf(ctx: Ctx, p: PlayerState): number {
  const s =
    p.baseSpeed *
    p.speedMul *
    (1 + p.buffs.speed.n * p.buffs.speed.amount) *
    (p.slowT > 0 ? 0.5 : 1);
  const liquid = p.inLiquid ? (ctx.d.liquidEffect(liquidKind(ctx), p.types).slow ?? 1) : 1;
  return s * liquid * weatherSpeedMult(ctx, p.types);
}

export const reductionOf = (p: PlayerState): number =>
  Math.min(0.8, p.damageReduction + p.buffs.defense.n * p.buffs.defense.amount);

export const regenOf = (p: PlayerState): number => p.regen + p.buffs.regen.n * p.buffs.regen.amount;

export function addBuff(p: PlayerState, stat: BuffStat, amount: number, dur: number, max: number) {
  const b = p.buffs[stat];
  b.amount = amount;
  b.n = Math.min(max, b.n + 1);
  b.t = dur;
}

// ---------------------------------------------------------------- damage and healing

export function typeLabel(k: number): HitLabel {
  return k > 1.05 ? 'super' : k < 0.95 ? 'weak' : null;
}

/** Damage to a player; `type` applies the type chart and weather (none: raw damage). */
export function hurtPlayer(
  ctx: Ctx,
  p: PlayerState,
  amount: number,
  type: EnemyState['attackType'] | null,
) {
  // Disconnected players are idle and invulnerable until they come back.
  if (p.invuln > 0 || p.dead || !p.connected || p.left || ctx.s.config.invulnerable) return;
  let label: HitLabel = null;
  if (type) {
    const k = ctx.d.typeMult(type, p.types);
    label = typeLabel(k);
    amount *= k * weatherDamageMult(ctx, type);
  }
  // With a melee move active you take 25% less: you have to stand in the crowd to hit.
  const close = activeGroup(p).some((m) => m.kind === 'melee') ? 0.75 : 1;
  const d = Math.max(1, amount * (1 - reductionOf(p)) * close);
  p.hp -= d;
  p.invuln = 0.45;
  emit(ctx, { type: 'player-hurt', playerId: p.id, amount: Math.round(d), label });
  // Focus Sash: survive a fatal hit with 1 HP (once a minute).
  if (p.hp <= 0 && p.item === 'focus-sash') {
    const params = ctx.d.item('focus-sash').params ?? {};
    if (p.sashAt === null || ctx.s.time - p.sashAt > (params.cooldownSeconds ?? 60)) {
      p.sashAt = ctx.s.time;
      p.hp = 1;
      p.invuln = params.invulnerableSeconds ?? 1.2;
      emit(ctx, { type: 'focus-sash', playerId: p.id });
    }
  }
  if (p.hp <= 0) knockOut(ctx, p);
}

function knockOut(ctx: Ctx, p: PlayerState) {
  p.hp = 0;
  p.dead = true;
  p.reviveT = 0;
  p.stats.timesDown++;
  clearOrbs(ctx, p.id);
  emit(ctx, { type: 'player-down', playerId: p.id });
  if (ctx.s.players.filter((o) => !o.left).length > 1) {
    emit(ctx, { type: 'say', key: 'hud.youReDownATeammate', seconds: 3, playerId: p.id });
  }
}

export function healPlayer(ctx: Ctx, p: PlayerState, amount: number): void {
  const before = p.hp;
  p.hp = Math.min(p.maxHp, p.hp + amount);
  const got = Math.round(p.hp - before);
  if (got >= 1) emit(ctx, { type: 'player-healed', playerId: p.id, amount: got });
}

export function addMaxHp(p: PlayerState, amount: number): void {
  p.maxHp += amount;
  p.hp += amount;
}

export function revivePlayer(ctx: Ctx, p: PlayerState, frac: number, by: PlayerState | null) {
  p.dead = false;
  p.hp = Math.max(1, p.maxHp * frac);
  p.invuln = 2;
  p.reviveT = 0;
  if (by) by.stats.revivesGiven++;
  emit(ctx, { type: 'player-revived', playerId: p.id, by: by?.id ?? null });
}

/** Down in a group: a teammate standing next to you revives you over a few seconds. */
export function reviveTick(ctx: Ctx, p: PlayerState): void {
  if (!p.dead || p.left) return;
  const helper = activePlayers(ctx.s).find(
    (o) => o !== p && !o.dead && dist2(o.x, o.y, p.x, p.y) < REVIVE_RANGE * REVIVE_RANGE,
  );
  p.reviveT = helper ? p.reviveT + DT : Math.max(0, p.reviveT - DT * 0.5);
  if (p.reviveT >= REVIVE_SECONDS) revivePlayer(ctx, p, 0.5, helper ?? null);
}

// ---------------------------------------------------------------- per tick

export function nearestEnemy(ctx: Ctx, x: number, y: number, maxDist: number): EnemyState | null {
  let best: EnemyState | null = null;
  let bd = maxDist * maxDist;
  for (const e of ctx.s.enemies) {
    if (e.dead) continue;
    const d = dist2(x, y, e.x, e.y);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

export function updatePlayer(ctx: Ctx, p: PlayerState): void {
  if (p.dead || p.left) return;
  const dt = DT;
  if (p.invuln > 0) p.invuln -= dt;
  for (const b of Object.values(p.buffs)) {
    if (b.n > 0) {
      b.t -= dt;
      if (b.t <= 0) b.n = 0;
    }
  }
  if (p.slowT > 0) p.slowT -= dt;
  if (p.bellHeal > 0) {
    const h = Math.min(p.bellHeal, 4 * dt);
    p.hp = Math.min(p.maxHp, p.hp + h);
    p.bellHeal -= h;
  }
  const regen = regenOf(p);
  if (regen > 0) p.hp = Math.min(p.maxHp, p.hp + regen * dt);

  // --- movement with collisions (disconnected players stand still) ---
  let [ax, ay] = p.connected ? [p.input.moveX, p.input.moveY] : [0, 0];
  const len = Math.hypot(ax, ay);
  if (len > 1) {
    ax /= len;
    ay /= len;
  }
  p.walking = ax !== 0 || ay !== 0;
  const s = speedOf(ctx, p);
  // Ice: you slide (velocity changes slowly).
  const slide = p.inLiquid && ctx.d.liquidEffect(liquidKind(ctx), p.types).slide;
  p.vx = slide ? damp(p.vx, ax * s * 1.15, 1.6, dt) : ax * s;
  p.vy = slide ? damp(p.vy, ay * s * 1.15, 1.6, dt) : ay * s;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  collide(ctx, p);
  if (p.walking) p.moveAngle = Math.atan2(ay, ax);

  // --- liquid ---
  p.inLiquid = isLiquid(ctx, p.x, p.y);
  if (p.inLiquid) {
    const le = ctx.d.liquidEffect(liquidKind(ctx), p.types);
    if (le.damage) {
      p.lavaTick -= dt;
      if (p.lavaTick <= 0) {
        p.lavaTick = le.every ?? 0.5;
        p.invuln = 0;
        hurtPlayer(ctx, p, Math.max(le.flat ?? 0, p.maxHp * le.damage * 0.5), null);
      }
    }
  }

  // --- aim: by priority for the active move; else at the nearest rock/chest; else where you walk ---
  //   ranged (projectile, beam): the boss if in range > whatever touches you > the nearest
  //   melee and the rest:        whatever touches you > the boss > the nearest
  // With a horde on you something always touches you; if that always won, ranged moves would
  // never hit the boss.
  const m = activeGroup(p)[0];
  const ranged = !!m && (m.kind === 'projectile' || m.kind === 'beam');
  const threat = nearestEnemy(ctx, p.x, p.y, p.r + 24);
  const boss =
    ctx.s.enemies.find((e) => e.boss && !e.dead && dist(p.x, p.y, e.x, e.y) < 330) ?? null;
  const enemy = (ranged ? boss || threat : threat || boss) || nearestEnemy(ctx, p.x, p.y, 520);
  if (enemy) {
    p.target = { kind: 'enemy', id: enemy.id };
    p.aim = Math.atan2(enemy.y - p.y, enemy.x - p.x);
  } else {
    const prop = nearestBreakable(ctx, p.x, p.y, 200);
    if (prop) {
      p.target = { kind: 'prop', key: prop.key };
      p.aim = Math.atan2(prop.y - p.y, prop.x - p.x);
    } else {
      p.target = null;
      if (p.walking) p.aim = p.moveAngle;
    }
  }
}

/** Smoothed velocity of each player (enemies lead their target; stragglers come back ahead). */
export function trackVelocities(ctx: Ctx): void {
  const dt = DT;
  const k = Math.min(1, dt * 5);
  for (const p of ctx.s.players) {
    p.smoothVx += ((p.x - p.prevX) / dt - p.smoothVx) * k;
    p.smoothVy += ((p.y - p.prevY) / dt - p.smoothVy) * k;
    if (Math.abs(p.x - p.prevX) > 200 || Math.abs(p.y - p.prevY) > 200) {
      p.smoothVx = 0; // teleport
      p.smoothVy = 0;
    }
    p.prevX = p.x;
    p.prevY = p.y;
  }
}

/** Where a target reference is now (null if gone). */
export function targetPos(ctx: Ctx, p: PlayerState): { x: number; y: number } | null {
  const t = p.target;
  if (!t) return null;
  if (t.kind === 'enemy') {
    const e = ctx.enemyById.get(t.id);
    return e && !e.dead ? e : null;
  }
  const [tx = 0, ty = 0] = t.key.split(',').map(Number);
  if (ctx.s.world.broken[t.key]) return null;
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE - 4 };
}

export const clampMoveInput = (v: number): number => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
