// Momentum: a per-player kill-streak damage bonus (tuning `momentum`). Every kill credited to a
// player (their last hit, or their burn/poison ticks) adds a stack, up to the cap; each stack
// multiplies their move damage. After `graceSeconds` without a kill the stacks drain at
// `decayPerSecond`, so a short pause doesn't wipe a streak. Taking damage doesn't touch it; a
// downed player can't kill, so theirs drains the same way.
import { DT } from './constants.js';
import type { Ctx } from './ctx.js';
import type { PlayerState } from './state.js';

export function addMomentum(ctx: Ctx, p: PlayerState): void {
  const m = ctx.d.game.tuning.momentum;
  p.momentum = Math.min(m.maxStacks, p.momentum + 1);
  p.momentumIdle = 0;
}

/** Every tick, for every player (down or not). */
export function tickMomentum(ctx: Ctx, p: PlayerState): void {
  const m = ctx.d.game.tuning.momentum;
  p.momentumIdle += DT;
  if (p.momentum > 0 && p.momentumIdle > m.graceSeconds) {
    p.momentum = Math.max(0, p.momentum - m.decayPerSecond * DT);
  }
}

/** The damage multiplier of `stacks` (players' `momentum`): ×(1 + perStack · stacks). */
export const momentumMultiplier = (ctx: Pick<Ctx, 'd'>, stacks: number): number =>
  1 + ctx.d.game.tuning.momentum.perStack * stacks;
