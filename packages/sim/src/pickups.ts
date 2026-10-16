// XP gems, coins and the other things on the ground (original implementation and the collect
// logic of game.js). They sit still until a player's magnet radius reaches them, then fly to the
// nearest player. Past `max` on the ground, the oldest XP gems merge.
import { DT, VIEW_H, VIEW_W } from './constants.js';
import { activePlayers, emit, nextId, type Ctx } from './ctx.js';
import { hurtEnemy } from './enemies.js';
import { damp, dist2 } from './math.js';
import { offerItem } from './items.js';
import { gainTeamXp } from './team.js';
import { healPlayer } from './players.js';
import type { PickupKind, PickupState, PlayerState } from './state.js';

/** Collect radius. */
const COLLECT_R = 15;

function makePickup(
  ctx: Ctx,
  kind: PickupKind,
  x: number,
  y: number,
  value: number,
  itemId: string | null,
): PickupState {
  const a = ctx.rand() * 6.2832;
  const sp = ctx.rand.range(10, 46);
  return {
    id: nextId(ctx.s),
    kind,
    x,
    y,
    vx: Math.cos(a) * sp,
    vy: Math.sin(a) * sp,
    value,
    itemId,
    pulled: false,
  };
}

function push(ctx: Ctx, o: PickupState): void {
  const list = ctx.s.pickups;
  list.push(o);
  if (list.length > ctx.d.game.tuning.pickups.max) {
    // Merge the two oldest XP gems so the ground doesn't grow without bound.
    const i = list.findIndex((p) => p.kind === 'xp' || p.kind === 'xp-big');
    if (i >= 0) {
      const [a] = list.splice(i, 1);
      const b = list.find((p) => p.kind === 'xp' || p.kind === 'xp-big');
      if (a && b) {
        b.value += a.value;
        b.kind = 'xp-big';
      }
    } else list.shift();
  }
}

/** Drops a loose pickup. `value`: coins or XP; `itemId` for held items. */
export function dropPickup(
  ctx: Ctx,
  kind: PickupKind,
  x: number,
  y: number,
  value = 0,
  itemId: string | null = null,
): void {
  push(ctx, makePickup(ctx, kind, x, y, value, itemId));
}

/**
 * XP from a defeated enemy (bosses burst into big XP gems and rewards), plus occasional drops:
 * tickets and gems (the currency, `gemDropRate`; a boss `bossGemChance`, a legendary
 * `legendaryGems`).
 */
export function dropXp(
  ctx: Ctx,
  x: number,
  y: number,
  value: number,
  boss = false,
  legend = false,
) {
  const { rand } = ctx;
  const tuning = ctx.d.game.tuning.pickups;
  if (boss) {
    for (let i = 0; i < 14; i++) {
      const a = rand() * 6.2832;
      const d = rand.range(10, 70);
      dropPickup(ctx, 'xp-big', x + Math.cos(a) * d, y + Math.sin(a) * d, Math.ceil(value / 14));
    }
    dropPickup(ctx, 'heal', x + 24, y);
    dropPickup(ctx, 'magnet', x - 24, y);
    if (rand() < (legend ? tuning.legendaryTicket10Chance : tuning.bossTicket10Chance)) {
      dropPickup(ctx, 'ticket10', x, y - 20, 1);
    }
    if (legend) {
      for (let i = 0; i < tuning.legendaryGems; i++)
        dropPickup(ctx, 'gem', x + rand.range(-20, 20), y + 20, 1);
    } else if (rand() < tuning.bossGemChance) dropPickup(ctx, 'gem', x, y + 20, 1);
    return;
  }
  dropPickup(ctx, value >= 20 ? 'xp-big' : 'xp', x, y, value);
  if (rand() < tuning.ticketDropRate) dropPickup(ctx, 'ticket', x + rand.range(-6, 6), y, 1);
  if (rand() < tuning.gemDropRate) dropPickup(ctx, 'gem', x + rand.range(-6, 6), y, 1);
  const r = rand();
  if (r < 0.012) dropPickup(ctx, 'heal', x + rand.range(-8, 8), y);
  else if (r < 0.02) dropPickup(ctx, 'magnet', x, y);
  else if (r < 0.026) dropPickup(ctx, 'bomb', x, y);
}

/** Magnet pickup: everything on the ground flies to the nearest player. */
export function pullAll(ctx: Ctx): void {
  for (const p of ctx.s.pickups) p.pulled = true;
}

export function updatePickups(ctx: Ctx): void {
  const dt = DT;
  const list = ctx.s.pickups;
  const players = activePlayers(ctx.s);
  if (!players.length) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p) continue;
    // The nearest player (alive, if there are several of you).
    let pl: PlayerState | null = null;
    let d2 = Infinity;
    for (const o of players) {
      if (o.dead && players.length > 1) continue;
      const dd = dist2(o.x, o.y, p.x, p.y);
      if (dd < d2) {
        d2 = dd;
        pl = o;
      }
    }
    if (!pl) continue;
    const dx = pl.x - p.x;
    const dy = pl.y - p.y;
    if (p.pulled || d2 < pl.magnet * pl.magnet) {
      p.pulled = true;
      const d = Math.sqrt(d2) || 1;
      const pull = 240 + 1400 / d;
      p.vx = damp(p.vx, (dx / d) * pull, 7, dt);
      p.vy = damp(p.vy, (dy / d) * pull, 7, dt);
    } else {
      p.vx *= Math.pow(0.02, dt);
      p.vy *= Math.pow(0.02, dt);
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (d2 < COLLECT_R * COLLECT_R) {
      list.splice(i, 1);
      collect(ctx, p, pl);
    }
  }
}

function collect(ctx: Ctx, p: PickupState, who: PlayerState): void {
  const { s } = ctx;
  emit(ctx, { type: 'pickup', playerId: who.id, kind: p.kind, x: p.x, y: p.y, value: p.value });
  switch (p.kind) {
    case 'xp':
    case 'xp-big':
      gainTeamXp(ctx, p.value);
      return;
    case 'coin':
      s.team.coins += p.value;
      return;
    case 'item':
      if (p.itemId) offerItem(ctx, who, p.itemId);
      return;
    case 'ticket':
      s.team.tickets++;
      return;
    case 'ticket10':
      s.team.tickets10++;
      return;
    case 'gem':
      s.team.gems++;
      return;
    case 'heal':
      healPlayer(ctx, who, who.maxHp * 0.3);
      return;
    case 'magnet':
      pullAll(ctx);
      emit(ctx, { type: 'magnet', playerId: who.id });
      return;
    case 'bomb': {
      // Hits every enemy the collector can see.
      emit(ctx, { type: 'bomb', playerId: who.id, x: who.x, y: who.y });
      const dmg = 60 + s.team.level * 14;
      for (const e of s.enemies) {
        if (e.dead) continue;
        if (Math.abs(e.x - who.x) > VIEW_W / 2 || Math.abs(e.y - who.y) > VIEW_H / 2) continue;
        hurtEnemy(ctx, e, dmg, {
          dirX: e.x - who.x,
          dirY: e.y - who.y,
          knockback: 160,
          by: who.id,
        });
      }
    }
  }
}
