// A player's moves and slots (legacy player.js addMove/arrange/setActive and data/moves.js
// instance/levelUp/evolve). Only the active slot fires; a slot can hold several moves cast
// together (2b: bonds fuse moves into one slot).
import { emit, type Ctx } from './ctx.js';
import { clearOrbs } from './projectiles.js';
import type { MoveState, PlayerState } from './state.js';

export function newMove(ctx: Ctx, id: string, level = 1): MoveState {
  const def = ctx.d.move(id);
  return {
    id,
    kind: def.kind,
    type: def.type,
    level,
    evolved: false,
    stats: ctx.d.moveStats(id, level, false),
    t: 0,
    castTick: -1,
  };
}

export const moveById = (p: PlayerState, id: string): MoveState | undefined =>
  p.moves.find((m) => m.id === id);

/** The moves in the active slot. */
export function activeGroup(p: PlayerState): MoveState[] {
  const slot = p.slots[p.active];
  if (!slot) return [];
  const out: MoveState[] = [];
  for (const id of slot) {
    const m = moveById(p, id);
    if (m) out.push(m);
  }
  return out;
}

/** Learns a move into a new slot (and switches to it, unless a bonded slot is active). */
export function addMove(ctx: Ctx, p: PlayerState, id: string, quiet = false): boolean {
  if (p.slots.length >= p.maxSlots || p.moves.some((m) => m.id === id)) return false;
  p.moves.push(newMove(ctx, id));
  const group = [id];
  p.slots.push(group);
  arrange(p);
  const cur = p.slots[p.active];
  if (!(cur && cur.length > 1)) setActive(ctx, p, p.slots.indexOf(group), quiet);
  if (!quiet) emit(ctx, { type: 'move-learned', playerId: p.id, moveId: id });
  return true;
}

/**
 * Fixed slots ("Shortcuts"): each move with a chosen slot goes there, for muscle memory. While you
 * have fewer moves than that, it goes to the closest one; the rest fill the free slots in the
 * order you learned them.
 */
export function arrange(p: PlayerState): void {
  const n = p.slots.length;
  if (n < 2) return;
  const want = (g: string[]) => {
    let k = Infinity;
    for (const id of g) {
      const b = p.bind[id];
      if (b != null) k = Math.min(k, b);
    }
    return k;
  };
  const cur = p.slots[p.active];
  const out: (string[] | null)[] = new Array<string[] | null>(n).fill(null);
  const bound = p.slots.filter((g) => want(g) < Infinity).sort((a, b) => want(a) - want(b));
  for (const g of bound) {
    let i = Math.min(want(g), n - 1);
    while (i >= 0 && out[i]) i--; // taken: the one before
    if (i < 0) {
      i = 0;
      while (out[i]) i++; // or the first free one
    }
    out[i] = g;
  }
  for (const g of p.slots) if (!out.includes(g)) out[out.indexOf(null)] = g;
  p.slots = out.filter((g): g is string[] => g !== null);
  if (cur) p.active = p.slots.indexOf(cur);
}

/** Switches the active slot. Locked by Choice Band once a slot is active. */
export function setActive(ctx: Ctx, p: PlayerState, i: number, quiet = false): void {
  if (i < 0 || i >= p.slots.length || i === p.active) return;
  if (p.item === 'choice-band' && p.slots[p.active]) {
    emit(ctx, { type: 'slot-locked', playerId: p.id, itemId: 'choice-band' });
    return;
  }
  p.active = i;
  clearOrbs(ctx, p.id);
  // The new move fires soon after switching.
  for (const m of activeGroup(p)) m.t = Math.min(m.t, (m.stats.cooldown ?? 0) * 0.35);
  if (!quiet) emit(ctx, { type: 'slot', playerId: p.id, slot: i });
}

export function cycleSlot(ctx: Ctx, p: PlayerState, dir: number): void {
  if (!p.slots.length) return;
  setActive(ctx, p, (p.active + dir + p.slots.length) % p.slots.length);
}

export function canLevelUp(ctx: Ctx, m: MoveState): boolean {
  return m.level < ctx.d.maxMoveLevel(m.id);
}

export function levelUpMove(ctx: Ctx, p: PlayerState, m: MoveState): boolean {
  if (!canLevelUp(ctx, m)) return false;
  m.level++;
  m.stats = ctx.d.moveStats(m.id, m.level, m.evolved);
  emit(ctx, { type: 'move-upgraded', playerId: p.id, moveId: m.id, level: m.level });
  return true;
}

/**
 * Evolution: a max-level move evolves once the player has taken its required stat card this run.
 * `ready` false: it's waiting for that card.
 */
export function evolutionInfo(
  ctx: Ctx,
  p: PlayerState,
  m: MoveState,
): { needs: string; ready: boolean } | null {
  const def = ctx.d.move(m.id);
  if (!def.evolution || m.evolved || canLevelUp(ctx, m)) return null;
  if (!ctx.d.game.moves.evolutionBoosts[m.kind]) return null;
  const needs = def.evolution.requires;
  return { needs, ready: (p.statsTaken[needs] ?? 0) > 0 };
}

export function evolveMove(ctx: Ctx, p: PlayerState, m: MoveState): boolean {
  if (m.evolved || !ctx.d.move(m.id).evolution) return false;
  m.evolved = true;
  m.stats = ctx.d.moveStats(m.id, m.level, true);
  p.stats.progress.evolutions.push(m.id);
  emit(ctx, { type: 'move-evolved', playerId: p.id, moveId: m.id });
  emit(ctx, { type: 'progress', event: 'evolve', playerId: p.id, data: { move: m.id } });
  return true;
}
