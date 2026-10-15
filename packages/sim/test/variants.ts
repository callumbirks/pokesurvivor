// Manual harness helper (not CI): put back an earlier release's balance data in the shared,
// already-loaded game data, so before/after runs come from one checkout.
import { simData } from '../src/data.js';

/**
 * v15 as released: rarity odds, Momentum, the wild curves (no HP curve) and the defence values in
 * damage reduction units (Armor card 0.05 to a 0.7 stat cap, upgrade 0.02, prestige 0.05, Assault
 * Vest 0.2, Harden 0.07). The damage formula itself stays toughness: before/after damage per hit
 * needs a v15 checkout; offers and ceilings match v15.
 */
export function applyV15(): void {
  const game = simData().game;
  const armor = game.statCardById.get('defense')!.effect as { value: number; cap?: number };
  armor.value = 0.05;
  armor.cap = 0.7;
  (game.upgradeById.get('defense') as { perLevel: number }).perLevel = 0.02;
  (game.tuning.prestige.perStar as { defense: number }).defense = 0.05;
  (game.itemById.get('assault-vest')!.effects[0] as { value: number }).value = 0.2;
  (game.moveById.get('harden')!.stats as { amount: number }).amount = 0.07;
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
