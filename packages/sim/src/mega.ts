// In-run Mega Evolution (tuning `mega`, megas.json). From `fromMinute`, a level-up offer of a
// Mega-capable partner can hold one "Unique" card (until it's taken). Picking it changes the
// partner's form for the rest of the run (the client draws the form's sprite; moves and types stay)
// and multiplies its stats once, in the same fields cards and items scale, so the stats panel and
// the balance samples include it. The game then stays paused while the client plays the
// transformation (`SimState.megaTicks`).
import type { MegaForm } from '@pokesurvivor/data';
import { noteMega } from './balance.js';
import { TICK_HZ } from './constants.js';
import { emit, type Ctx } from './ctx.js';
import { addMaxHp } from './players.js';
import { rarityWeights } from './rarity.js';
import type { CardOption, PlayerState } from './state.js';

/** The form a player's partner can take (undefined: it can't). */
export const megaFormOf = (ctx: Ctx, p: PlayerState): MegaForm | undefined =>
  ctx.d.game.megaByDex.get(p.dex);

/**
 * The chance a level-up offer holds the Unique card now: `legendaryFactor` × the chance a stat
 * card rolls the top rarity tier at this minute. 0 for a partner that can't, or already did, or
 * before `fromMinute`.
 */
export function megaChance(ctx: Ctx, p: PlayerState): number {
  const m = ctx.d.game.tuning.mega;
  const minute = ctx.s.time / 60;
  if (p.megaAt != null || minute < m.fromMinute || !megaFormOf(ctx, p)) return 0;
  const w = rarityWeights(ctx.d.game.levelUp.rarity.odds, minute);
  const total = w.reduce((a, x) => a + x, 0);
  return total > 0 ? Math.min(1, (m.legendaryFactor * (w.at(-1) ?? 0)) / total) : 0;
}

export const megaCard = (dex: number): CardOption => ({ id: `mega:${dex}`, type: 'mega' });

/** Picked the Unique card: the form, the boost (once) and the pause for the animation. */
export function applyMega(ctx: Ctx, p: PlayerState): void {
  const form = megaFormOf(ctx, p);
  if (!form || p.megaAt != null) return;
  const m = ctx.d.game.tuning.mega;
  p.megaAt = ctx.s.time;
  p.attackMul *= m.attackMul;
  p.speedMul *= m.speedMul;
  p.cooldownMul *= m.cooldownMul;
  // The max HP added is healed, like Vigor's.
  const add = Math.round(p.maxHp * (m.maxHpMul - 1));
  if (add > 0) addMaxHp(p, add);
  else p.maxHp = Math.max(1, p.maxHp + add);
  p.hp = Math.min(p.hp, p.maxHp);
  // The form's own size (Mega Steelix and the Primals are much bigger).
  p.r = ctx.d.game.megaBodyByDex.get(p.dex)?.radius ?? p.r;
  ctx.s.megaTicks = Math.max(ctx.s.megaTicks, Math.round(m.animationSeconds * TICK_HZ));
  noteMega(ctx, p, form);
  emit(ctx, { type: 'mega-evolved', playerId: p.id, dex: p.dex, kind: form.kind });
}
