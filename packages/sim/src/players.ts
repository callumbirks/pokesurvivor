// The players' Pokémon (original implementation, logic only): stats, movement with collisions,
// liquids, auto-aim (or the player's manual aim), damage, healing, going down and being revived.
import { prestigeBonus } from '@pokesurvivor/data';
import { emptyRunProgress } from '@pokesurvivor/protocol';
import type { HitSource } from '@pokesurvivor/protocol';
import { newBalance, noteDamageTaken, noteDown, noteRevive } from './balance.js';
import { DT, TILE } from './constants.js';
import { activePlayers, emit, type Ctx } from './ctx.js';
import { clamp, damp, dist, dist2 } from './math.js';
import { momentumMultiplier, tickMomentum } from './momentum.js';
import { activeGroup, addMove, setActive } from './moves.js';
import { clearOrbs } from './projectiles.js';
import { weatherDamageMult, weatherSpeedMult } from './weather.js';
import { capRegularHit } from './wilddamage.js';
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
  /**
   * The second starting move chosen for "Repertoire". Used only while it's still valid (an
   * attacking move of the pool, not the starting move, not banned); otherwise a random one.
   */
  secondMove?: string;
  /** Preferred slot per move ("Shortcuts"): `moveBindings[slot] = moveId`. */
  moveBindings?: readonly (string | null)[];
  /** Dex numbers of the legendaries this player has beaten (unbeaten ones come up more in rifts). */
  legendsBeaten?: readonly number[];
  /** Prestige stars of this Pokémon (0–3): a bonus on top of its upgrades (`prestigeBonus`). */
  prestige?: number;
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
  // Prestige multiplies the upgraded stats and adds points where upgrades add points.
  const star = prestigeBonus(d.game.tuning.prestige, cfg.prestige);
  const maxHp = Math.round((mon.hp + perks.hp) * star.hpMul);
  // Side by side at the centre of the starting clearing.
  const x = (index - (count - 1) / 2) * 34;
  const p: PlayerState = {
    id: cfg.id,
    dex: cfg.dex,
    shiny: !!cfg.shiny && body.shiny,
    types: [...mon.types],
    index,
    relocationTokens: d.game.tuning.stragglers.burst,
    connected: true,
    left: false,
    input: { moveX: 0, moveY: 0, slot: null, aim: null, fire: false },
    x,
    y: 0,
    r: body.radius,
    vx: 0,
    vy: 0,
    smoothVx: 0,
    smoothVy: 0,
    travelVx: 0,
    travelVy: 0,
    prevX: x,
    prevY: 0,
    walking: false,
    moveAngle: Math.PI / 2,
    aim: Math.PI / 2,
    target: null,
    hp: maxHp,
    maxHp,
    baseSpeed: mon.speed,
    baseAttack: mon.attack,
    attackMul: perks.attackMul * star.damageMul,
    speedMul: perks.speedMul * star.speedMul,
    cooldownMul: perks.cooldownMul * star.cooldownMul,
    defense: perks.defense + star.defense,
    regen: perks.regen,
    magnet: BASE_MAGNET * perks.magnetMul,
    xpMul: perks.xpMul,
    coinMul: perks.coinMul,
    critChance: perks.crit + star.crit,
    buffs: { attack: newBuff(), speed: newBuff(), defense: newBuff(), regen: newBuff() },
    momentum: 0,
    momentumIdle: 0,
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
    cardMul: {},
    cardAdd: {},
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
    balance: newBalance({
      prestige: cfg.prestige ?? 0,
      upgrades: Object.fromEntries(Object.entries(cfg.upgrades ?? {}).filter(([, l]) => l > 0)),
      players: count,
      atkUpgrade: perks.attackMul,
      atkPrestige: star.damageMul,
    }),
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
  // "Repertoire" upgrade: a second attacking move, the chosen one or else a random one (a valid
  // choice draws nothing from the RNG).
  if (perks.startMoves >= 2) {
    const pool = d
      .movePool(p.types)
      .filter((id) => !hasMove(p, id) && !p.banned.includes(id) && d.move(id).kind !== 'buff');
    const chosen = pool.find((id) => id === cfg.secondMove);
    if (chosen) addMove(ctx, p, chosen, true);
    else if (pool.length) addMove(ctx, p, ctx.rand.pick(pool), true);
    setActive(ctx, p, 0, true);
  }
  p.balance.startMoves = p.moves.map((m) => m.id);
  return p;
}

export const hasMove = (p: PlayerState, id: string): boolean => p.moves.some((m) => m.id === id);

// ---------------------------------------------------------------- effective stats

/** Move damage scale: base, Power and perks, the attack buff, and Momentum. */
export const attackOf = (ctx: Ctx, p: PlayerState): number =>
  p.baseAttack *
  p.attackMul *
  (1 + p.buffs.attack.n * p.buffs.attack.amount) *
  momentumMultiplier(ctx, p.momentum);

export function speedOf(ctx: Ctx, p: PlayerState): number {
  return moveSpeedOf(ctx, p) * liquidSpeedMult(ctx, p);
}

/**
 * Movement speed before the liquid underfoot: stats, buffs, traps and the weather. Snapshots send
 * it to the player's own client, which predicts its movement with `moveBody`.
 */
export function moveSpeedOf(ctx: Ctx, p: PlayerState): number {
  return (
    p.baseSpeed *
    p.speedMul *
    (1 + p.buffs.speed.n * p.buffs.speed.amount) *
    (p.slowT > 0 ? 0.5 : 1) *
    weatherSpeedMult(ctx, p.types)
  );
}

/** The slow of the liquid a body stands in (1 out of it, or immune). */
export function liquidSpeedMult(ctx: Ctx, b: Pick<MovingBody, 'inLiquid' | 'types'>): number {
  return b.inLiquid ? (ctx.d.liquidEffect(liquidKind(ctx), b.types).slow ?? 1) : 1;
}

/** What `moveBody` moves: a player, or a client's prediction of its own player. */
export type MovingBody = Pick<
  PlayerState,
  'x' | 'y' | 'r' | 'vx' | 'vy' | 'types' | 'inLiquid' | 'walking' | 'moveAngle'
>;

/**
 * One tick of walking: input (clamped to length 1) at `speed` (`speedOf`), ice slides, walls and
 * solid props, then whether the body ended up in liquid. Shared by the sim and client prediction.
 */
export function moveBody(ctx: Ctx, p: MovingBody, moveX: number, moveY: number, speed: number) {
  const dt = DT;
  let ax = moveX;
  let ay = moveY;
  const len = Math.hypot(ax, ay);
  if (len > 1) {
    ax /= len;
    ay /= len;
  }
  p.walking = ax !== 0 || ay !== 0;
  // Ice: you slide (velocity changes slowly).
  const slide = p.inLiquid && ctx.d.liquidEffect(liquidKind(ctx), p.types).slide;
  p.vx = slide ? damp(p.vx, ax * speed * 1.15, 1.6, dt) : ax * speed;
  p.vy = slide ? damp(p.vy, ay * speed * 1.15, 1.6, dt) : ay * speed;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  collide(ctx, p);
  if (p.walking) p.moveAngle = Math.atan2(ay, ax);
  p.inLiquid = isLiquid(ctx, p.x, p.y);
}

/** Defence in effect (with Harden's stacks), up to `tuning.defense.max`: damage is ÷ (1 + it). */
export const defenseOf = (ctx: Pick<Ctx, 'd'>, p: PlayerState): number =>
  Math.min(ctx.d.game.tuning.defense.max, p.defense + p.buffs.defense.n * p.buffs.defense.amount);

export const regenOf = (p: PlayerState): number => p.regen + p.buffs.regen.n * p.buffs.regen.amount;

/**
 * What the HUD's stats panel shows of a player's own Pokémon: attack, speed and max HP with their
 * species base (the current value over it is the whole multiplier), and the stats that have no
 * base as they apply. Attack leaves out Momentum, which changes with every kill: the HUD shows
 * it live and multiplies it in (`momentumMultiplier`).
 */
export interface PlayerStats {
  attackBase: number;
  /** `attackOf` without Momentum: upgrades, cards, item and attack buffs. */
  attack: number;
  speedBase: number;
  /** `moveSpeedOf`: upgrades, cards, item, buffs, a trap's slow and the weather. */
  speed: number;
  hpBase: number;
  maxHp: number;
  /** Cooldown multiplier. */
  cooldown: number;
  /** Defence in effect (`defenseOf`): +% toughness, 1 = +100% (half damage). */
  defense: number;
  /** HP per second (`regenOf`). */
  regen: number;
  /** Pickup radius multiplier. */
  magnet: number;
  /** XP multiplier. */
  xp: number;
  /** Critical hit chance, 0–1. */
  crit: number;
}

export function statsOf(ctx: Ctx, p: PlayerState): PlayerStats {
  const mon = ctx.d.game.pokemonByDex.get(p.dex);
  return {
    attackBase: p.baseAttack,
    attack: attackOf(ctx, p) / momentumMultiplier(ctx, p.momentum),
    speedBase: p.baseSpeed,
    speed: moveSpeedOf(ctx, p),
    hpBase: mon?.hp ?? p.maxHp,
    maxHp: p.maxHp,
    cooldown: p.cooldownMul,
    defense: defenseOf(ctx, p),
    regen: regenOf(p),
    magnet: p.magnet / BASE_MAGNET,
    xp: p.xpMul,
    crit: p.critChance,
  };
}

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

/**
 * Damage to a player; `type` applies the type chart and weather (none: raw damage). `by`: what
 * hit them, for the balance record.
 */
export function hurtPlayer(
  ctx: Ctx,
  p: PlayerState,
  amount: number,
  type: EnemyState['attackType'] | null,
  regular = false,
  by: HitSource | null = null,
) {
  // Disconnected players are idle and invulnerable until they come back.
  if (p.invuln > 0 || p.dead || !p.connected || p.left || ctx.s.config.invulnerable) return;
  let label: HitLabel = null;
  let weather = 1;
  if (type) {
    const k = ctx.d.typeMult(type, p.types);
    label = typeLabel(k);
    amount *= k;
    weather = weatherDamageMult(ctx, type);
  }
  // With a melee move active you take 25% less: you have to stand in the crowd to hit.
  const close = activeGroup(p).some((m) => m.kind === 'melee') ? 0.75 : 1;
  const defended = (amount / (1 + defenseOf(ctx, p))) * close;
  const capped = regular
    ? capRegularHit(defended, p.maxHp, ctx.d.game.tuning.spawner.regularHitCapFraction)
    : defended;
  const d = Math.max(1, capped * weather);
  p.hp -= d;
  noteDamageTaken(ctx, p, d, by);
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
  noteDown(ctx, p);
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
  noteRevive(ctx, p);
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
  tickMomentum(ctx, p);
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
  const [ax, ay] = p.connected ? [p.input.moveX, p.input.moveY] : [0, 0];
  moveBody(ctx, p, ax, ay, speedOf(ctx, p));

  // --- liquid ---
  if (p.inLiquid) {
    const le = ctx.d.liquidEffect(liquidKind(ctx), p.types);
    if (le.damage) {
      p.lavaTick -= dt;
      if (p.lavaTick <= 0) {
        p.lavaTick = le.every ?? 0.5;
        p.invuln = 0;
        hurtPlayer(ctx, p, Math.max(le.flat ?? 0, p.maxHp * le.damage * 0.5), null, false, {
          kind: 'liquid',
        });
      }
    }
  }

  // --- auto-aim: by priority for the active move; else at the nearest rock/chest; else where you
  //     walk. With manual aim the target is still picked (it gates targeted moves: see combat.ts)
  //     but the aim is the player's. ---
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
  if (isManualAim(p)) p.aim = p.input.aim;
}

/** Is the player aiming by hand (`input.aim` set)? */
export const isManualAim = (p: PlayerState): p is PlayerState & { input: { aim: number } } =>
  p.input.aim != null;

/**
 * Is the player attacking? A cast keeps it attacking until just after the move's next cast
 * (`markAttacking`), so a run of casts is one attack. Trail pools and orbits don't count.
 */
export const isAttacking = (time: number, p: Pick<PlayerState, 'attackingUntil'>): boolean =>
  time < p.attackingUntil;

/**
 * Where a player's Pokémon faces (original implementation): its aim while attacking (the auto target, or
 * the manual aim), else where it walks; standing still, its aim. Renderers use this so the sprite doesn't flip between casts.
 */
export function facingOf(p: {
  attacking: boolean;
  walking: boolean;
  aim: number;
  moveAngle: number;
}): number {
  return p.attacking || !p.walking ? p.aim : p.moveAngle;
}

/** Track actual movement: short lead for runners, longer history for arrivals. */
export function trackVelocities(ctx: Ctx): void {
  const dt = DT;
  const k = Math.min(1, dt * 5);
  const travelK = 1 - Math.exp(-dt / ctx.d.game.tuning.spawner.directionBias.smoothingSeconds);
  for (const p of ctx.s.players) {
    p.smoothVx += ((p.x - p.prevX) / dt - p.smoothVx) * k;
    p.smoothVy += ((p.y - p.prevY) / dt - p.smoothVy) * k;
    p.travelVx += ((p.x - p.prevX) / dt - p.travelVx) * travelK;
    p.travelVy += ((p.y - p.prevY) / dt - p.travelVy) * travelK;
    if (Math.abs(p.x - p.prevX) > 200 || Math.abs(p.y - p.prevY) > 200) {
      p.smoothVx = 0; // teleport
      p.smoothVy = 0;
      p.travelVx = p.travelVy = 0;
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

/** A manual aim from input: an angle in [-π, π], or null (auto-aim) if absent or not finite. */
export function clampAimInput(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v >= -Math.PI && v <= Math.PI ? v : Math.atan2(Math.sin(v), Math.cos(v));
}
