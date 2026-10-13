// Pending choices (level-up cards, item swaps) are state, keyed by (playerId, choiceId): a client
// that misses a message sees them again in the next snapshot, so nothing can get stuck. While any
// is pending the whole game is paused, as in legacy co-op. Each one auto-resolves to its first
// option at its deadline, or straight away if its player disconnects or leaves.
import { emit, playerById, type Ctx } from './ctx.js';
import { applyCard, offerCards } from './levelup.js';
import { resolveItemChoice } from './items.js';
import type { ItemChoice, LevelUpChoice, PendingChoice, PlayerId } from './state.js';

type NewChoice =
  Omit<LevelUpChoice, 'id' | 'deadlineTick'> | Omit<ItemChoice, 'id' | 'deadlineTick'>;

export type ChoiceResult = { ok: true } | { ok: false; error: string };

export function openChoice(ctx: Ctx, c: NewChoice): PendingChoice {
  const { s } = ctx;
  const timeout = s.config.choiceTimeoutTicks;
  const choice = {
    ...c,
    id: s.nextChoiceId++,
    deadlineTick: timeout === null ? null : s.tick + timeout,
  };
  s.pendingChoices.push(choice);
  const p = playerById(s, c.playerId);
  if (!p || !p.connected || p.left) resolveChoice(ctx, choice, null);
  return choice;
}

/** First option: the first card, or keeping the held item. */
function defaultOption(c: PendingChoice): string | null {
  return c.kind === 'level-up' ? (c.options[0]?.id ?? null) : c.held;
}

/** Applies an option (`null`: the default one) and removes the choice. */
export function resolveChoice(ctx: Ctx, c: PendingChoice, optionId: string | null): ChoiceResult {
  const { s } = ctx;
  const i = s.pendingChoices.indexOf(c);
  if (i < 0) return { ok: false, error: 'no such choice' };
  const auto = optionId === null;
  const pick = optionId ?? defaultOption(c);
  const p = playerById(s, c.playerId);
  if (c.kind === 'level-up') {
    const card = c.options.find((o) => o.id === pick);
    if (!card && c.options.length) return { ok: false, error: 'not an offered card' };
    s.pendingChoices.splice(i, 1);
    if (card && p) applyCard(ctx, p, card);
  } else {
    if (pick !== c.held && pick !== c.found) return { ok: false, error: 'not an offered item' };
    s.pendingChoices.splice(i, 1);
    if (p && pick) resolveItemChoice(ctx, p, pick);
  }
  emit(ctx, { type: 'choice-resolved', playerId: c.playerId, choiceId: c.id, auto });
  return { ok: true };
}

export function findChoice(
  ctx: Ctx,
  playerId: PlayerId,
  choiceId: number,
): PendingChoice | undefined {
  return ctx.s.pendingChoices.find((c) => c.playerId === playerId && c.id === choiceId);
}

/** Rerolls the cards of a level-up choice (1 free per run plus the "Card reroll" upgrades). */
export function rerollChoice(ctx: Ctx, c: PendingChoice): ChoiceResult {
  const p = playerById(ctx.s, c.playerId);
  if (c.kind !== 'level-up' || !p) return { ok: false, error: 'not a level-up choice' };
  if (rerollsLeft(p) <= 0) return { ok: false, error: 'no rerolls left' };
  p.rerollsUsed++;
  c.options = offerCards(ctx, p);
  return { ok: true };
}

export const rerollsLeft = (p: { rerollBonus: number; rerollsUsed: number }): number =>
  Math.max(0, 1 + p.rerollBonus - p.rerollsUsed);

/** Resolves every choice of a player (they disconnected or left). */
export function autoResolveFor(ctx: Ctx, playerId: PlayerId): void {
  for (const c of ctx.s.pendingChoices.filter((o) => o.playerId === playerId)) {
    resolveChoice(ctx, c, null);
  }
}

/** Resolves choices whose deadline has passed. */
export function tickChoices(ctx: Ctx): void {
  const { s } = ctx;
  for (const c of s.pendingChoices.slice()) {
    if (c.deadlineTick !== null && s.tick >= c.deadlineTick) resolveChoice(ctx, c, null);
  }
}
