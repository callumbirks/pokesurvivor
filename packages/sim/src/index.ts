// @pokesurvivor/sim: the headless game simulation (see README.md).
export {
  CHUNK,
  CHUNK_TILES,
  DT,
  OUTER_RADIUS,
  TICK_HZ,
  TICK_MS,
  TILE,
  VIEW_H,
  VIEW_W,
  drainTicks,
} from './constants.js';
export { MAX_PLAYERS, Sim, createSim, restoreSim } from './sim.js';
export type { Intent, MoveInput, SimConfig } from './sim.js';
export type { PlayerConfig } from './players.js';
export { REVIVE_RANGE, REVIVE_SECONDS, facingOf, isAttacking, moveSpeedOf } from './players.js';
export type { MovingBody } from './players.js';
export { WorldView, moveStatsAt, playerMoveSpeed } from './view.js';
export { MANUAL_AIM_CONE } from './combat.js';
export { hash2 } from './math.js';
export { momentumCap } from './momentum.js';
export { rerollsLeft } from './choices.js';
export { rarityTier, rarityWeights, scaledCardEffect } from './rarity.js';
export type { ChoiceResult } from './choices.js';
export type { HitLabel, ProgressEventName, SimEvent, SimEventType } from './events.js';
export { playerRunSummary } from './summary.js';
export type { OwnsPokemon, PlayerSummary, RunSummary } from './summary.js';
export { hashString, stateHash } from './hash.js';
export { FLOOR, LIQUID, WALL, liquidKind, propHp, propsInRect, terrainRaw } from './world.js';
export { BOND_MAX, bondOptions } from './bonds.js';
export type { Prop, PropType, Terrain } from './world.js';
export type * from './state.js';
