// Telegraphed enemy attacks (original implementation): a warning on the ground that fills up,
// then hits every player inside when `t` reaches `delay`.
//   zone  circle (ground/fire/poison zones, explosions, jump landings)
//   beam  straight line from the enemy (electric, psychic, dragon, ice)
import { DT } from './constants.js';
import { activePlayers, emit, nextId, type Ctx } from './ctx.js';
import { dist2 } from './math.js';
import { hurtPlayer } from './players.js';
import type { HazardState } from './state.js';

/** Seconds a detonated hazard stays (for the visual). */
const LINGER = 0.3;

export type HazardInit = Pick<HazardState, 'kind' | 'x' | 'y' | 'delay' | 'damage' | 'type'> &
  Partial<Pick<HazardState, 'r' | 'angle' | 'len' | 'w'>>;

export function addHazard(ctx: Ctx, h: HazardInit): HazardState {
  const o: HazardState = {
    id: nextId(ctx.s),
    r: 0,
    angle: 0,
    len: 0,
    w: 0,
    t: 0,
    hit: false,
    ...h,
  };
  ctx.s.hazards.push(o);
  return o;
}

export function insideHazard(h: HazardState, x: number, y: number, r: number): boolean {
  if (h.kind === 'zone') return dist2(x, y, h.x, h.y) < (h.r + r * 0.6) ** 2;
  const ca = Math.cos(h.angle);
  const sa = Math.sin(h.angle);
  const px = x - h.x;
  const py = y - h.y;
  const along = px * ca + py * sa;
  if (along < -r || along > h.len + r) return false;
  return Math.abs(-px * sa + py * ca) <= h.w / 2 + r * 0.6;
}

export function updateHazards(ctx: Ctx): void {
  const list = ctx.s.hazards;
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (!h) continue;
    h.t += DT;
    if (!h.hit && h.t >= h.delay) {
      h.hit = true;
      emit(ctx, { type: 'hazard', id: h.id, phase: 'hit' });
      for (const p of activePlayers(ctx.s)) {
        if (p.dead || !insideHazard(h, p.x, p.y, p.r)) continue;
        p.invuln = 0;
        hurtPlayer(ctx, p, h.damage, h.type);
      }
    }
    if (h.hit && h.t >= h.delay + LINGER) list.splice(i, 1);
  }
}
