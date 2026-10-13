// Bonds (legacy entities/player.js bondOptions/fuse and game.js offerBond). Each rift win gives
// every player a bond: it fuses moves into one slot, cast together. Only one group grows (up to
// BOND_MAX moves); with none to grow, a bond pairs two loose moves. A bond you can't use yet (fewer
// than two loose moves) is saved until you learn another move.
//
// Spending one is a `bond` choice: like level-up cards it pauses everyone, has the same deadline,
// and auto-resolves (to the first option) on timeout or disconnect. A disconnected player isn't
// offered one: the bond waits until they're back.
import { openChoice } from './choices.js';
import { emit, activePlayers, type Ctx } from './ctx.js';
import { arrange } from './moves.js';
import { clearOrbs } from './projectiles.js';
import type { BondChoice, PlayerState } from './state.js';

/** Moves in one bonded slot at most. */
export const BOND_MAX = 4;

export interface BondOptions {
  mode: 'pair' | 'add';
  group: string[] | null;
  loose: string[];
}

/** What a bond can do now: grow the bonded group, or pair two loose moves (null: nothing yet). */
export function bondOptions(p: PlayerState): BondOptions | null {
  const loose = p.slots.filter((g) => g.length === 1).map((g) => g[0] as string);
  const grow = p.slots.find((g) => g.length > 1 && g.length < BOND_MAX);
  if (grow) return loose.length ? { mode: 'add', group: [...grow], loose } : null;
  return loose.length >= 2 ? { mode: 'pair', group: null, loose } : null;
}

/** The moves a bond choice fuses by default (first options). */
export function defaultBond(c: BondChoice): string[] {
  return c.mode === 'add' ? c.loose.slice(0, 1) : c.loose.slice(0, 2);
}

/** Is `moves` a valid pick for this choice? */
export function validBond(c: BondChoice, moves: readonly string[]): boolean {
  if (!moves.every((m) => c.loose.includes(m))) return false;
  if (c.mode === 'add') return moves.length === 1;
  return moves.length === 2 && moves[0] !== moves[1];
}

/** Fuses loose `moves` into `group` (or a new group) and spends a bond. */
export function fuse(ctx: Ctx, p: PlayerState, moves: readonly string[], group: string[] | null) {
  const same = (g: string[]) =>
    !!group && g.length === group.length && g.every((m, i) => m === group[i]);
  const target = group ? p.slots.find(same) : p.slots.find((g) => g[0] === moves[0]);
  if (!target) return;
  const cur = p.slots[p.active];
  for (const m of moves) {
    if (target.includes(m)) continue;
    const i = p.slots.findIndex((g) => g.length === 1 && g[0] === m);
    if (i < 0) continue;
    p.slots.splice(i, 1);
    target.push(m);
  }
  arrange(p);
  // Switch to the group, except with Choice Band (you stay on the slot you had, if it's still there).
  const a = cur ? p.slots.indexOf(cur) : -1;
  p.active = p.item === 'choice-band' && a >= 0 ? a : p.slots.indexOf(target);
  p.bonds = Math.max(0, p.bonds - 1);
  clearOrbs(ctx, p.id);
  emit(ctx, { type: 'bond-formed', playerId: p.id, moves: [...target] });
  emit(ctx, {
    type: 'say',
    key: 'hud.bondMovesAtOnce',
    params: { 0: target.length },
    seconds: 2.6,
    playerId: p.id,
  });
}

/** Offers a bond choice to every player who has a bond and can use it. Only when nothing else is pending. */
export function offerBonds(ctx: Ctx): void {
  const { s } = ctx;
  if (s.pendingChoices.length || s.arena) return;
  for (const p of activePlayers(s)) {
    if (p.bonds <= 0 || p.dead) continue;
    const opt = bondOptions(p);
    if (opt) openChoice(ctx, { kind: 'bond', playerId: p.id, ...opt });
  }
}
