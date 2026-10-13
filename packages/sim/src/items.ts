// Held items (legacy data/items.js and game.js offerItem): one per player. Stat effects from
// items.json apply while held; the reactive ones (Focus Sash, Shell Bell, Life Orb, Rocky Helmet,
// Choice Band) are checked where they trigger.
import { emit, type Ctx } from './ctx.js';
import { openChoice } from './choices.js';
import type { StatEffect } from '@pokesurvivor/data';
import type { ItemChoice, PlayerState } from './state.js';

function applyEffect(p: PlayerState, e: StatEffect, on: boolean): void {
  if (e.op === 'mul') {
    p[e.stat] = on ? p[e.stat] * e.value : p[e.stat] / e.value;
    return;
  }
  if (e.perMaxHp) {
    // Sized by max HP when equipped (Leftovers); removed by the same amount.
    if (on) p.itemRegen = e.value * p.maxHp;
    p[e.stat] += on ? p.itemRegen : -p.itemRegen;
    return;
  }
  p[e.stat] += on ? e.value : -e.value;
}

/** Puts on an item (taking off the one held). */
export function equip(ctx: Ctx, p: PlayerState, id: string | null): void {
  if (p.item) for (const e of ctx.d.item(p.item).effects) applyEffect(p, e, false);
  p.item = id;
  if (id) for (const e of ctx.d.item(id).effects) applyEffect(p, e, true);
}

function takeItem(ctx: Ctx, p: PlayerState, id: string): void {
  if (id === p.item) return;
  equip(ctx, p, id);
  // Other swaps this player still has to decide are now against the new item.
  for (const c of ctx.s.pendingChoices) if (c.kind === 'item' && c.playerId === p.id) c.held = id;
  const name = ctx.d.item(id).name;
  emit(ctx, { type: 'item-equipped', playerId: p.id, itemId: id });
  emit(ctx, {
    type: 'say',
    key: 'items.youReHolding',
    params: { 0: name },
    seconds: 2.6,
    playerId: p.id,
  });
  p.stats.progress.itemsEquipped.push(id);
  emit(ctx, { type: 'progress', event: 'item', playerId: p.id, data: { id } });
}

/** Picked up an item: wear it if you hold none, otherwise choose (the game pauses meanwhile). */
export function offerItem(ctx: Ctx, p: PlayerState, id: string): void {
  if (!p.item) {
    takeItem(ctx, p, id);
    return;
  }
  if (p.item === id) {
    const name = ctx.d.item(id).name;
    emit(ctx, {
      type: 'say',
      key: 'items.youAlreadyHold',
      params: { 0: name },
      seconds: 2,
      playerId: p.id,
    });
    return;
  }
  openChoice(ctx, { kind: 'item', playerId: p.id, held: p.item, found: id });
}

/** Resolves an item choice: switch to the found item, or keep the held one. */
export function resolveItemChoice(ctx: Ctx, p: PlayerState, c: ItemChoice, keep: string): void {
  if (keep === c.found) takeItem(ctx, p, c.found);
}

/** Life Orb: every cast costs a little HP (never knocks you out). Legacy behaviour, see §4. */
export function lifeOrbCost(ctx: Ctx, p: PlayerState): void {
  if (p.item !== 'life-orb') return;
  const params = ctx.d.item('life-orb').params ?? {};
  p.hp = Math.max(
    1,
    p.hp - Math.max(params.minHpCost ?? 1, p.maxHp * (params.hpCostPerCast ?? 0.01)),
  );
}

/** Shell Bell: heal a share of the damage dealt (banked, applied at up to 4 HP/s). */
export function onDamageDealt(ctx: Ctx, p: PlayerState, dmg: number): void {
  if (p.item !== 'shell-bell') return;
  const params = ctx.d.item('shell-bell').params ?? {};
  p.bellHeal = Math.min(
    params.maxBankedHeal ?? 4,
    p.bellHeal + dmg * (params.healPerDamage ?? 0.04),
  );
}
