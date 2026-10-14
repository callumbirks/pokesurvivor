// Casting moves and resolving hits (original implementation). Only the active slot fires, each
// move on its own cooldown. Every attack also damages breakable props. Things a move leaves on
// the map (mines, meteors, turrets, trail pools) are `fields`.
import { DT } from './constants.js';
import { activePlayers, emit, nextId, playerById, type Ctx } from './ctx.js';
import { applyStatus, hurtEnemy, queryEnemies } from './enemies.js';
import type { SimEvent } from './events.js';
import { lifeOrbDrain, markAttacking, onDamageDealt } from './items.js';
import { TAU, dist, dist2, inArc, norm, segDist2 } from './math.js';
import { activeGroup } from './moves.js';
import {
  addBuff,
  attackOf,
  hurtPlayer,
  isManualAim,
  nearestEnemy,
  targetPos,
  typeLabel,
} from './players.js';
import { spawnProjectile } from './projectiles.js';
import { weatherDamageMult } from './weather.js';
import { collide, damageProp, isFree, isWall, projectileBlock, propsInCircle } from './world.js';
import type { HitLabel } from './events.js';
import type { EnemyState, FieldState, MoveState, PlayerState, StatusPayload } from './state.js';
import type { PokemonType } from '@pokesurvivor/data';

type CastInfo = Pick<Extract<SimEvent, { type: 'cast' }>, 'length' | 'chain'>;

const TARGETED = new Set([
  'melee',
  'beam',
  'projectile',
  'boomerang',
  'chain',
  'meteor',
  'dash',
  'cone',
]);

const int = (v: number | undefined) => Math.trunc(v ?? 0);

/**
 * Manual aim and moves that land on an enemy (chain, meteor): they pick from the enemies within
 * this half-angle of the aim. Direction moves (projectile, cone, beam, melee, boomerang, dash, and
 * where a turret goes) just use `p.aim`, which is the manual aim then.
 */
export const MANUAL_AIM_CONE = Math.PI / 4;

/** Enemies within `range` of the player and `MANUAL_AIM_CONE` of its aim. */
function enemiesInAim(ctx: Ctx, p: PlayerState, range: number): EnemyState[] {
  return queryEnemies(ctx, p.x, p.y, range).filter(
    (e) =>
      !e.dead &&
      dist2(p.x, p.y, e.x, e.y) <= range * range &&
      inArc(p.x, p.y, e.x, e.y, p.aim, MANUAL_AIM_CONE),
  );
}

/** The nearest enemy in the aim cone (manual aim), or null. */
function aimedEnemy(ctx: Ctx, p: PlayerState, range: number): EnemyState | null {
  let best: EnemyState | null = null;
  let bd = Infinity;
  for (const e of enemiesInAim(ctx, p, range)) {
    const d = dist2(p.x, p.y, e.x, e.y);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

/** How close the target must be before a targeted move fires. */
function reach(m: MoveState): number {
  const s = m.stats;
  switch (m.kind) {
    case 'melee':
      return (s.radius ?? 0) + 30;
    case 'beam':
      return (s.radius ?? 0) + 20;
    case 'boomerang':
      return (s.radius ?? 0) + 40;
    case 'chain':
      return 280;
    case 'meteor':
      return 340;
    case 'dash':
      return (s.radius ?? 0) + 60;
    case 'cone':
      return (s.speed ?? 0) * (s.lifetime ?? 0) + 30;
    default:
      return 520;
  }
}

const payload = (m: MoveState): StatusPayload => ({
  burn: m.stats.burn ?? 0,
  poison: m.stats.poison ?? 0,
  slow: m.stats.slow ?? 0,
  knockback: m.stats.knockback ?? 0,
});

const isCrit = (ctx: Ctx, p: PlayerState) => p.critChance > 0 && ctx.rand() < p.critChance;

/** Type chart × weather for an attack of `type` against `e`. */
const typeK = (ctx: Ctx, type: PokemonType | null, e: EnemyState) =>
  ctx.d.typeMult(type, e.types) * weatherDamageMult(ctx, type);

/** A player's attack hits an enemy: type chart, crits, Shell Bell, statuses. */
function hit(
  ctx: Ctx,
  p: PlayerState,
  e: EnemyState,
  dmg: number,
  dirX: number,
  dirY: number,
  knockback: number,
  type: PokemonType | null,
  status: StatusPayload,
): void {
  const k = typeK(ctx, type, e);
  const crit = isCrit(ctx, p);
  dmg *= k * (crit ? ctx.d.game.tuning.combat.critMultiplier : 1);
  const label: HitLabel = crit ? 'crit' : typeLabel(ctx.d.typeMult(type, e.types));
  hurtEnemy(ctx, e, dmg, { dirX, dirY, knockback, label, by: p.id, type });
  onDamageDealt(ctx, p, dmg);
  p.stats.damageDealt += dmg;
  applyStatus(e, status);
}

// ---------------------------------------------------------------- casting

export function tickCombat(ctx: Ctx): void {
  for (const p of activePlayers(ctx.s)) {
    if (p.dead) continue;
    // Bonds: every move of the active slot, each on its own cooldown.
    for (const m of activeGroup(p)) tickMove(ctx, p, m);
    lifeOrbDrain(ctx, p);
  }
}

function tickMove(ctx: Ctx, p: PlayerState, m: MoveState): void {
  if (m.kind === 'orbit') {
    orbit(ctx, p, m);
    return;
  }
  m.t -= DT;
  if (m.t > 0) return;
  // Targeted moves wait for a target in reach (no animation wasted on thin air). With manual
  // aim, the auto target still says whether there's anything to fight, unless fire is held: then
  // they fire anyway. A chain, which needs an enemy to start from, always waits for one in the
  // aim cone.
  if (TARGETED.has(m.kind) && !targetInReach(ctx, p, m)) {
    m.t = 0.05;
    return;
  }
  m.t = Math.max(0.05, (m.stats.cooldown ?? 0) * p.cooldownMul);
  // Attacking, for Life Orb (legacy didn't charge trails or orbits either).
  if (m.kind !== 'trail') markAttacking(ctx, p, m.t);
  m.castTick = ctx.s.tick;
  const x = p.x;
  const y = p.y;
  const info = run(ctx, p, m);
  // Trail pools are silent: one per step would be a constant buzz.
  if (m.kind !== 'trail') {
    emit(ctx, {
      type: 'cast',
      playerId: p.id,
      moveId: m.id,
      kind: m.kind,
      moveType: m.type,
      x,
      y,
      aim: p.aim,
      ...info,
    });
  }
}

function targetInReach(ctx: Ctx, p: PlayerState, m: MoveState): boolean {
  if (m.kind === 'chain' && isManualAim(p)) return aimedEnemy(ctx, p, reach(m)) !== null;
  if (isManualAim(p) && p.input.fire) return true;
  const tg = targetPos(ctx, p);
  return !!tg && dist(p.x, p.y, tg.x, tg.y) <= reach(m);
}

function run(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  switch (m.kind) {
    case 'projectile':
      return fireProjectiles(ctx, p, m);
    case 'melee':
      return melee(ctx, p, m);
    case 'beam':
      return beam(ctx, p, m);
    case 'nova':
      return nova(ctx, p, m);
    case 'aura':
      return aura(ctx, p, m);
    case 'buff':
      addBuff(
        p,
        ctx.d.move(m.id).buffStat ?? 'attack',
        m.stats.amount ?? 0,
        m.stats.duration ?? 0,
        int(m.stats.stacks),
      );
      return {};
    case 'boomerang':
      return boomerang(ctx, p, m);
    case 'chain':
      return chain(ctx, p, m);
    case 'mine':
      return mines(ctx, p, m);
    case 'meteor':
      return meteors(ctx, p, m);
    case 'turret':
      return turret(ctx, p, m);
    case 'dash':
      return dash(ctx, p, m);
    case 'trail':
      return trail(ctx, p, m);
    case 'cone':
      return cone(ctx, p, m);
    case 'orbit':
      return {};
  }
}

function shot(
  ctx: Ctx,
  p: PlayerState,
  m: MoveState,
  a: number,
  speed: number,
  life: number,
  offset: number,
) {
  const s = m.stats;
  spawnProjectile(ctx, {
    ownerId: p.id,
    moveId: m.id,
    type: m.type,
    x: p.x + Math.cos(a) * offset,
    y: p.y + Math.sin(a) * offset,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    damage: (s.damage ?? 0) * attackOf(p),
    r: s.size ?? 6,
    life,
    pierce: int(s.pierce),
    homing: s.homing ?? 0,
    ...payload(m),
  });
}

function fireProjectiles(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const n = Math.max(1, int(s.count));
  const spread = s.spread ?? 0;
  for (let i = 0; i < n; i++) {
    const off = n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * n;
    shot(ctx, p, m, p.aim + off + ctx.rand.range(-0.03, 0.03), s.speed ?? 0, s.lifetime ?? 1.4, 3);
  }
  return {};
}

function nova(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const n = Math.max(3, int(s.count));
  for (let i = 0; i < n; i++) {
    shot(
      ctx,
      p,
      m,
      (i / n) * TAU + ctx.rand.range(-0.06, 0.06),
      s.speed ?? 0,
      s.lifetime ?? 1.4,
      3,
    );
  }
  return {};
}

function cone(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const n = Math.max(2, int(s.count));
  const arc = s.arc || 0.9;
  for (let i = 0; i < n; i++) {
    const a = p.aim + (i / (n - 1) - 0.5) * arc + ctx.rand.range(-0.05, 0.05);
    const sp = (s.speed ?? 0) * ctx.rand.range(0.85, 1.1);
    shot(ctx, p, m, a, sp, (s.lifetime ?? 0) * ctx.rand.range(0.85, 1.05), 4);
  }
  return {};
}

function melee(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const radius = s.radius ?? 0;
  const half = Math.min(s.arc ?? 0, TAU) / 2;
  const dmg = (s.damage ?? 0) * attackOf(p);
  for (const e of queryEnemies(ctx, p.x, p.y, radius)) {
    if (!inArc(p.x, p.y, e.x, e.y, p.aim, half)) continue;
    hit(ctx, p, e, dmg, e.x - p.x, e.y - p.y, s.knockback ?? 0, m.type, payload(m));
  }
  for (const pr of propsInCircle(ctx, p.x, p.y, radius)) {
    if (inArc(p.x, p.y, pr.x, pr.y, p.aim, half)) damageProp(ctx, pr, dmg);
  }
  return {};
}

function beam(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const w = s.width ?? 0;
  const ca = Math.cos(p.aim);
  const sa = Math.sin(p.aim);
  const radius = s.radius ?? 0;
  // The beam stops at the first wall.
  let len = radius;
  for (let d = 8; d < radius; d += 8) {
    if (isWall(ctx, p.x + ca * d, p.y + sa * d)) {
      len = d;
      break;
    }
  }
  const dmg = (s.damage ?? 0) * attackOf(p);
  const mx = p.x + (ca * len) / 2;
  const my = p.y + (sa * len) / 2;
  const onBeam = (x: number, y: number, r: number) => {
    const px = x - p.x;
    const py = y - p.y;
    const along = px * ca + py * sa;
    if (along < -r || along > len + r) return false;
    return Math.abs(-px * sa + py * ca) <= w / 2 + r;
  };
  for (const e of queryEnemies(ctx, mx, my, len / 2 + w)) {
    if (onBeam(e.x, e.y, e.r)) hit(ctx, p, e, dmg, ca, sa, 0, m.type, payload(m));
  }
  for (const pr of propsInCircle(ctx, mx, my, len / 2 + w)) {
    if (onBeam(pr.x, pr.y, pr.r)) damageProp(ctx, pr, dmg);
  }
  return { length: len };
}

function aura(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const radius = s.radius ?? 0;
  const dmg = (s.damage ?? 0) * attackOf(p);
  for (const e of queryEnemies(ctx, p.x, p.y, radius)) {
    hit(ctx, p, e, dmg, e.x - p.x, e.y - p.y, 0, m.type, payload(m));
  }
  for (const pr of propsInCircle(ctx, p.x, p.y, radius)) damageProp(ctx, pr, dmg);
  return {};
}

/** Boomerang: flies at the enemy, stops and comes back, hitting on the way out and back. */
function boomerang(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const n = Math.max(1, int(s.count));
  const spread = s.spread || 0.5;
  const speed = s.speed ?? 1;
  const out = (s.radius ?? 0) / speed; // seconds out
  for (let i = 0; i < n; i++) {
    const a = p.aim + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * Math.min(n, 3));
    spawnProjectile(ctx, {
      ownerId: p.id,
      moveId: m.id,
      type: m.type,
      x: p.x,
      y: p.y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      damage: (s.damage ?? 0) * attackOf(p),
      r: s.size ?? 6,
      life: out * 4 + 1.5,
      pierce: 999,
      boomerang: out,
      returnSpeed: speed * 1.1,
      ...payload(m),
    });
  }
  return {};
}

/**
 * Chain: hits one enemy and jumps to the next nearest ones (15% less each jump). It starts at the
 * target, or with manual aim at the nearest enemy in the aim cone.
 */
function chain(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  let cur: EnemyState | null;
  if (isManualAim(p)) cur = aimedEnemy(ctx, p, reach(m));
  else {
    const t = p.target?.kind === 'enemy' ? ctx.enemyById.get(p.target.id) : undefined;
    cur = t && !t.dead ? t : nearestEnemy(ctx, p.x, p.y, reach(m));
  }
  if (!cur) return {};
  let fx = p.x;
  let fy = p.y;
  let k = 1;
  const done = new Set<number>();
  const points: { x: number; y: number }[] = [];
  const n = Math.max(1, int(s.count));
  const radius = s.radius ?? 0;
  for (let i = 0; i < n && cur; i++) {
    done.add(cur.id);
    const tx = cur.x;
    const ty = cur.y;
    points.push({ x: tx, y: ty });
    // Hex: more damage to whoever already suffers a status.
    const hex = s.hexBonus && (cur.burn > 0 || cur.poison > 0 || cur.slow > 0) ? s.hexBonus : 1;
    hit(
      ctx,
      p,
      cur,
      (s.damage ?? 0) * attackOf(p) * k * hex,
      tx - fx,
      ty - fy,
      0,
      m.type,
      payload(m),
    );
    k *= 0.85;
    fx = tx;
    fy = ty;
    let best: EnemyState | null = null;
    let bd = radius * radius;
    for (const e of queryEnemies(ctx, cur.x, cur.y, radius)) {
      if (done.has(e.id)) continue;
      const d = dist2(cur.x, cur.y, e.x, e.y);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    cur = best;
  }
  return { chain: points };
}

function newField(
  ctx: Ctx,
  p: PlayerState,
  m: MoveState,
  kind: FieldState['kind'],
  x: number,
  y: number,
): FieldState {
  const s = m.stats;
  return {
    id: nextId(ctx.s),
    kind,
    ownerId: p.id,
    moveId: m.id,
    type: m.type,
    x,
    y,
    t: 0,
    life: 0,
    r: s.radius ?? 0,
    damage: (s.damage ?? 0) * attackOf(p),
    arm: 0,
    shotT: 0,
    range: 0,
    rate: 0,
    speed: 0,
    size: 0,
    pierce: 0,
    gone: false,
    ...payload(m),
  };
}

/** Marks a player's oldest fields of a kind as gone, keeping `keep`. */
function capFields(ctx: Ctx, p: PlayerState, kind: FieldState['kind'], keep: number): void {
  const mine = ctx.s.fields.filter((f) => f.kind === kind && f.ownerId === p.id && !f.gone);
  for (const f of mine.slice(0, Math.max(0, mine.length - keep))) f.gone = true;
}

/** Mines: stay on the ground and blow up when an enemy steps on them. */
function mines(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const n = Math.max(1, int(m.stats.count));
  for (let i = 0; i < n; i++) {
    const a = ctx.rand() * TAU;
    const d = n === 1 ? 0 : ctx.rand.range(18, 46);
    const f = newField(ctx, p, m, 'mine', p.x + Math.cos(a) * d, p.y + Math.sin(a) * d * 0.8);
    f.arm = 0.35;
    f.life = m.stats.duration || 7;
    ctx.s.fields.push(f);
  }
  // A few per player at most: the oldest go.
  capFields(ctx, p, 'mine', 4 + n * 2);
  return {};
}

/**
 * Meteors: fall on nearby enemies (the shadow warns where). With manual aim, on the enemies in the
 * aim cone, and the ones left over somewhere along the aim instead of anywhere around.
 */
function meteors(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const n = Math.max(1, int(m.stats.count));
  const manual = isManualAim(p);
  const near = ctx.rand.shuffle(
    manual
      ? enemiesInAim(ctx, p, reach(m))
      : queryEnemies(ctx, p.x, p.y, reach(m)).filter((e) => !e.dead),
  );
  for (let i = 0; i < n; i++) {
    const e = near[i];
    let x: number;
    let y: number;
    if (e) {
      x = e.x + ctx.rand.range(-8, 8);
      y = e.y + ctx.rand.range(-6, 6);
    } else if (manual) {
      const a = p.aim + ctx.rand.range(-0.25, 0.25);
      const d = ctx.rand.range(70, reach(m) * 0.75);
      x = p.x + Math.cos(a) * d;
      y = p.y + Math.sin(a) * d;
    } else {
      x = p.x + ctx.rand.range(-140, 140);
      y = p.y + ctx.rand.range(-110, 110);
    }
    const f = newField(ctx, p, m, 'meteor', x, y);
    f.t = -i * 0.09;
    f.arm = 0.5; // fall time
    ctx.s.fields.push(f);
  }
  return {};
}

/** Turret: leaves something on the ground that shoots by itself for a while. */
function turret(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const a = p.aim + Math.PI + ctx.rand.range(-0.6, 0.6);
  const f = newField(ctx, p, m, 'turret', p.x + Math.cos(a) * 26, p.y + Math.sin(a) * 20);
  f.life = s.duration || 6;
  f.shotT = 0.3;
  f.range = s.range || 300;
  f.rate = s.rate || 0.6;
  f.speed = s.speed || 300;
  f.size = s.size || 6;
  f.pierce = int(s.pierce);
  ctx.s.fields.push(f);
  capFields(ctx, p, 'turret', Math.max(1, int(s.count)));
  return {};
}

/** Dash: you streak towards the enemy, hitting everything on the way (briefly invulnerable). */
function dash(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const s = m.stats;
  const ca = Math.cos(p.aim);
  const sa = Math.sin(p.aim);
  const sx = p.x;
  const sy = p.y;
  const radius = s.radius ?? 0;
  let len = 0;
  for (let d = 8; d <= radius; d += 8) {
    if (!isFree(ctx, sx + ca * d, sy + sa * d, p.r * 0.8, true)) break;
    len = d;
  }
  p.x = sx + ca * len;
  p.y = sy + sa * len;
  collide(ctx, p);
  p.invuln = Math.max(p.invuln, 0.3);
  const w = s.width || 34;
  const dmg = (s.damage ?? 0) * attackOf(p);
  const mx = sx + (ca * len) / 2;
  const my = sy + (sa * len) / 2;
  for (const e of queryEnemies(ctx, mx, my, len / 2 + w)) {
    if (segDist2(sx, sy, p.x, p.y, e.x, e.y) <= (w / 2 + e.r) ** 2) {
      hit(ctx, p, e, dmg, ca, sa, s.knockback ?? 0, m.type, payload(m));
    }
  }
  for (const pr of propsInCircle(ctx, mx, my, len / 2 + w)) {
    if (segDist2(sx, sy, p.x, p.y, pr.x, pr.y) <= (w / 2 + pr.r) ** 2) damageProp(ctx, pr, dmg);
  }
  return { length: len };
}

/** Trail: you leave pools that hurt whatever walks over them. */
function trail(ctx: Ctx, p: PlayerState, m: MoveState): CastInfo {
  const radius = m.stats.radius ?? 0;
  // Standing still doesn't stack a new pool on the last one (only now and then).
  const last =
    p.lastPatchId === null ? undefined : ctx.s.fields.find((f) => f.id === p.lastPatchId);
  if (last && dist2(last.x, last.y, p.x, p.y) < (radius * 0.9) ** 2 && last.t < 1) return {};
  const f = newField(ctx, p, m, 'patch', p.x, p.y);
  f.life = m.stats.duration || 3;
  ctx.s.fields.push(f);
  p.lastPatchId = f.id;
  capFields(ctx, p, 'patch', 18);
  return {};
}

/** Orbit: orbs circle the player while the move is active (they re-hit on their own timer). */
function orbit(ctx: Ctx, p: PlayerState, m: MoveState): void {
  const s = m.stats;
  const want = Math.max(1, int(s.count));
  const mine = (q: { orb: boolean; ownerId: string | null; moveId: string | null }) =>
    q.orb && q.ownerId === p.id && q.moveId === m.id;
  const orbs = ctx.s.projectiles.filter(mine);
  // When the orb count changes (an upgrade), spread them evenly from where the first one is.
  const relayout = orbs.length !== want;
  const base = orbs[0] ? orbs[0].orbAngle : ctx.s.time * (s.speed ?? 0);
  if (orbs.length > want) {
    const extra = new Set(orbs.slice(want).map((o) => o.id));
    ctx.s.projectiles = ctx.s.projectiles.filter((q) => !extra.has(q.id));
  }
  for (let i = orbs.length; i < want; i++) {
    spawnProjectile(ctx, {
      ownerId: p.id,
      moveId: m.id,
      type: m.type,
      orb: true,
      x: p.x,
      y: p.y,
      r: s.size ?? 6,
      damage: (s.damage ?? 0) * attackOf(p),
      orbAngle: (i / want) * TAU,
      orbRadius: s.radius ?? 0,
      orbSpeed: s.speed ?? 0,
      rehit: Math.max(0.12, s.cooldown ?? 0),
      ...payload(m),
    });
  }
  const live = ctx.s.projectiles.filter(mine);
  live.forEach((q, i) => {
    q.damage = (s.damage ?? 0) * attackOf(p);
    q.orbRadius = s.radius ?? 0;
    q.orbSpeed = s.speed ?? 0;
    q.r = s.size ?? 6;
    if (relayout) q.orbAngle = base + (i / live.length) * TAU;
  });
  // A "concentrate" animation now and then, so it looks alive.
  p.orbCastT -= DT;
  if (p.orbCastT <= 0) {
    p.orbCastT = 1.6;
    m.castTick = ctx.s.tick;
    emit(ctx, {
      type: 'cast',
      playerId: p.id,
      moveId: m.id,
      kind: m.kind,
      moveType: m.type,
      x: p.x,
      y: p.y,
      aim: p.aim,
    });
  }
}

// ---------------------------------------------------------------- fields

/** A field's damage to everything in its circle. */
function blast(ctx: Ctx, f: FieldState, r: number, k = 1): void {
  const p = playerById(ctx.s, f.ownerId);
  if (!p) return;
  for (const e of queryEnemies(ctx, f.x, f.y, r)) {
    hit(ctx, p, e, f.damage * k, e.x - f.x, e.y - f.y, f.knockback, f.type, f);
  }
  for (const pr of propsInCircle(ctx, f.x, f.y, r)) damageProp(ctx, pr, f.damage * k);
  emit(ctx, { type: 'field-blast', id: f.id, x: f.x, y: f.y, r });
}

export function updateFields(ctx: Ctx): void {
  const dt = DT;
  const fields = ctx.s.fields;
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    if (!f) continue;
    f.t += dt;
    const owner = playerById(ctx.s, f.ownerId);
    if (f.gone || !owner || owner.left || (f.life && f.t >= f.life && f.kind !== 'mine')) {
      fields.splice(i, 1);
      continue;
    }
    if (f.kind === 'mine') {
      const armed = f.t >= f.arm;
      const trig = armed && queryEnemies(ctx, f.x, f.y, 14).length > 0;
      if (trig || f.t >= f.life) {
        fields.splice(i, 1);
        blast(ctx, f, f.r, trig ? 1 : 0.5);
      }
    } else if (f.kind === 'meteor') {
      if (f.t >= f.arm) {
        fields.splice(i, 1);
        blast(ctx, f, f.r);
      }
    } else if (f.kind === 'turret') {
      f.shotT -= dt;
      if (f.shotT <= 0) {
        const tg = nearestEnemy(ctx, f.x, f.y, f.range);
        f.shotT = tg ? f.rate : 0.15;
        if (tg) {
          const a = Math.atan2(tg.y - f.y, tg.x - f.x);
          spawnProjectile(ctx, {
            ownerId: f.ownerId,
            moveId: f.moveId,
            type: f.type,
            x: f.x,
            y: f.y,
            vx: Math.cos(a) * f.speed,
            vy: Math.sin(a) * f.speed,
            damage: f.damage,
            r: f.size,
            life: 1.4,
            pierce: f.pierce,
            burn: f.burn,
            poison: f.poison,
            slow: f.slow,
            knockback: f.knockback,
          });
        }
      }
    } else {
      // Trail pool: hurts every half second.
      f.shotT -= dt;
      if (f.shotT <= 0) {
        f.shotT = 0.5;
        blast(ctx, f, f.r);
      }
    }
  }
}

// ---------------------------------------------------------------- collisions

export function resolveCollisions(ctx: Ctx): void {
  const { s } = ctx;
  const now = s.time;
  const list = s.projectiles;
  const targets = activePlayers(s).filter((p) => !p.dead);

  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p) continue;

    // --- enemy shots: walls and solid props give cover ---
    if (!p.friendly) {
      if (projectileBlock(ctx, p.x, p.y, p.r)) {
        list.splice(i, 1);
        continue;
      }
      for (const pl of targets) {
        if (dist2(p.x, p.y, pl.x, pl.y) < (p.r + pl.r) ** 2) {
          hurtPlayer(ctx, pl, p.damage, p.type);
          list.splice(i, 1);
          break;
        }
      }
      continue;
    }

    // --- player shots ---
    const owner = p.ownerId === null ? undefined : playerById(s, p.ownerId);
    if (!owner) {
      list.splice(i, 1);
      continue;
    }
    if (!p.orb) {
      const block = projectileBlock(ctx, p.x, p.y, p.r);
      if (block === 'wall' || (block && !block.destructible)) {
        list.splice(i, 1);
        continue;
      }
    } else {
      // Forget orb hits older than the re-hit time (orbs last the whole run).
      for (const k in p.hitLog) if (now - (p.hitLog[k] ?? 0) >= p.rehit) delete p.hitLog[k];
    }

    // Props (rocks, chests, grass).
    let consumed = false;
    for (const prop of propsInCircle(ctx, p.x, p.y, p.r)) {
      if (p.orb) {
        const k = `p${prop.key}`;
        if (now - (p.hitLog[k] ?? -99) < p.rehit) continue;
        p.hitLog[k] = now;
        damageProp(ctx, prop, p.damage);
        continue;
      }
      if (p.propHits.includes(prop.key)) continue;
      p.propHits.push(prop.key);
      damageProp(ctx, prop, p.damage);
      // Grass doesn't stop a shot; solid props use up pierce.
      if (prop.solid) {
        if (p.pierce > 0) p.pierce--;
        else {
          consumed = true;
          break;
        }
      }
    }
    if (consumed) {
      list.splice(i, 1);
      continue;
    }

    // Enemies. SWEPT collision: the whole segment moved this tick, not just the end point, or
    // fast shots skip over enemies hugging the player.
    const sx = p.orb ? p.x : p.px;
    const sy = p.orb ? p.y : p.py;
    const half = Math.hypot(p.x - sx, p.y - sy) / 2;
    for (const e of queryEnemies(ctx, (sx + p.x) / 2, (sy + p.y) / 2, half + p.r)) {
      if (segDist2(sx, sy, p.x, p.y, e.x, e.y) > (p.r + e.r) ** 2) continue;
      if (p.orb) {
        const k = `e${e.id}`;
        if (now - (p.hitLog[k] ?? -99) < p.rehit) continue;
        p.hitLog[k] = now;
      } else {
        if (p.hits.includes(e.id)) continue;
        p.hits.push(e.id);
      }
      hit(
        ctx,
        owner,
        e,
        p.damage,
        p.vx || e.x - owner.x,
        p.vy || e.y - owner.y,
        p.knockback,
        p.type,
        p,
      );
      if (!p.orb) {
        if (p.pierce > 0) p.pierce--;
        else {
          list.splice(i, 1);
          break;
        }
      }
    }
  }

  // --- enemy contact ---
  for (const pl of targets) {
    for (const e of queryEnemies(ctx, pl.x, pl.y, pl.r + 40)) {
      if (dist2(e.x, e.y, pl.x, pl.y) > (e.r + pl.r) ** 2) continue;
      if (e.touchCd > 0 || e.behavior === 'thief') continue;
      e.touchCd = 0.55;
      emit(ctx, { type: 'enemy-action', id: e.id, action: 'strike' });
      hurtPlayer(ctx, pl, e.damage, e.attackType);
      if (pl.item === 'rocky-helmet') {
        const prm = ctx.d.item('rocky-helmet').params ?? {};
        hurtEnemy(ctx, e, (prm.damageBase ?? 15) + s.team.level * (prm.damagePerLevel ?? 4), {
          dirX: e.x - pl.x,
          dirY: e.y - pl.y,
          knockback: prm.knockback ?? 80,
          by: pl.id,
        });
      }
      const [nx, ny] = norm(e.x - pl.x, e.y - pl.y);
      e.kx += nx * 150;
      e.ky += ny * 150;
    }
  }
}
