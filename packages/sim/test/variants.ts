// Manual harness helper (not CI): put back an earlier release's balance data in the shared,
// already-loaded game data, so before/after runs come from one checkout.
import { simData } from '../src/data.js';

/** v15 as released: rarity odds, Momentum and the wild curves (no HP curve). */
export function applyV15(): void {
  const game = simData().game;
  (game.levelUp.rarity as { odds: unknown }).odds = [
    { minute: 0, weights: [70, 22, 7, 1] },
    { minute: 15, weights: [40, 35, 20, 5] },
    { minute: 25, weights: [25, 35, 27, 13] },
    { minute: 30, weights: [15, 30, 35, 20] },
  ];
  Object.assign(game.tuning.momentum, {
    perStack: 0.02,
    maxStacksStart: 10,
    maxStacksFullMinute: 10,
    maxStacks: 30,
    graceSeconds: 3,
    decayPerSecond: 5,
  });
  Object.assign(game.tuning.spawner, {
    damageCurve: [
      { minute: 0, multiplier: 0.5 },
      { minute: 2, multiplier: 0.735 },
      { minute: 4, multiplier: 0.75 },
      { minute: 8, multiplier: 0.98 },
      { minute: 10, multiplier: 0.72 },
      { minute: 15, multiplier: 1.08 },
    ],
    hpCurve: [
      { minute: 0, multiplier: 1 },
      { minute: 8, multiplier: 1 },
    ],
  });
}
