// Everything that flies (legacy entities/projectile.js): player shots, enemy shots and the orbs
// that circle a player (`orb`: anchored to their owner, re-hitting every `rehit` s). Collisions
// are in combat.ts.
import { DT } from './constants.js';
import { nextId, playerById, seenByAny, type Ctx } from './ctx.js';
import { damp, dist2, norm } from './math.js';
import { nearestEnemy } from './players.js';
import type { EntityId, PlayerId, ProjectileState } from './state.js';

export type ProjectileInit = Partial<ProjectileState> &
  Pick<ProjectileState, 'x' | 'y' | 'damage' | 'r'>;

export function spawnProjectile(ctx: Ctx, o: ProjectileInit): ProjectileState {
  const p: ProjectileState = {
    id: nextId(ctx.s),
    friendly: true,
    ownerId: null,
    moveId: null,
    type: null,
    vx: 0,
    vy: 0,
    px: o.x,
    py: o.y,
    life: 1.4,
    t: 0,
    pierce: 0,
    homing: 0,
    hits: [],
    propHits: [],
    orb: false,
    orbAngle: 0,
    orbRadius: 0,
    orbSpeed: 0,
    rehit: 0.34,
    hitLog: {},
    boomerang: 0,
    returnSpeed: 0,
    back: false,
    burn: 0,
    poison: 0,
    slow: 0,
    knockback: 0,
    ...o,
  };
  ctx.s.projectiles.push(p);
  return p;
}

/** Removes a player's orbs (when they switch moves, go down or leave). */
export function clearOrbs(ctx: Ctx, ownerId: PlayerId): void {
  ctx.s.projectiles = ctx.s.projectiles.filter((p) => !p.orb || p.ownerId !== ownerId);
}

export function removeProjectile(ctx: Ctx, id: EntityId): void {
  const i = ctx.s.projectiles.findIndex((p) => p.id === id);
  if (i >= 0) ctx.s.projectiles.splice(i, 1);
}

export function updateProjectiles(ctx: Ctx): void {
  const dt = DT;
  const list = ctx.s.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p) continue;
    p.t += dt;
    const owner = p.ownerId === null ? undefined : playerById(ctx.s, p.ownerId);

    if (p.orb) {
      if (!owner || owner.left) {
        list.splice(i, 1);
        continue;
      }
      p.orbAngle += p.orbSpeed * dt;
      p.x = owner.x + Math.cos(p.orbAngle) * p.orbRadius;
      p.y = owner.y + Math.sin(p.orbAngle) * p.orbRadius * 0.7;
      continue;
    }

    if (p.t >= p.life) {
      list.splice(i, 1);
      continue;
    }

    // Boomerang: after `boomerang` s it turns back (and can hit the same enemies again) and
    // returns to its owner, vanishing on arrival.
    if (p.boomerang && owner) {
      if (!p.back && p.t >= p.boomerang) {
        p.back = true;
        p.hits = [];
      }
      if (p.back) {
        const [dx, dy] = norm(owner.x - p.x, owner.y - p.y);
        p.vx = damp(p.vx, dx * p.returnSpeed, 7, dt);
        p.vy = damp(p.vy, dy * p.returnSpeed, 7, dt);
        if (dist2(p.x, p.y, owner.x, owner.y) < (owner.r + 8) ** 2) {
          list.splice(i, 1);
          continue;
        }
      }
    }

    // Homing: bends towards the nearest enemy.
    if (p.homing > 0 && p.friendly) {
      const tg = nearestEnemy(ctx, p.x, p.y, 340);
      if (tg) {
        const [dx, dy] = norm(tg.x - p.x, tg.y - p.y);
        const sp = Math.hypot(p.vx, p.vy);
        p.vx = damp(p.vx, dx * sp, p.homing, dt);
        p.vy = damp(p.vy, dy * sp, p.homing, dt);
      }
    }

    p.px = p.x;
    p.py = p.y;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Far out of everyone's view: dropped.
    if (!seenByAny(ctx.s, p.x, p.y, 260)) list.splice(i, 1);
  }
}
