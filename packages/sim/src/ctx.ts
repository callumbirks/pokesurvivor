// What every system function gets: the state, the static data, the RNG, the event sink and the
// derived caches.
import { VIEW_H, VIEW_W } from './constants.js';
import type { SimData } from './data.js';
import type { SimEvent } from './events.js';
import type { Rand } from './rng.js';
import type { EnemyState, EntityId, PlayerId, PlayerState, SimState } from './state.js';
import type { ChunkCache } from './world.js';
import type { PathField } from './pathing.js';

export interface Ctx {
  s: SimState;
  d: SimData;
  rand: Rand;
  events: SimEvent[];
  /** World chunks generated so far (a pure function of the seed and the broken props). */
  chunks: ChunkCache;
  /** Spatial grid of live enemies, rebuilt from the state when they move. */
  grid: Map<number, EnemyState[]>;
  enemyById: Map<EntityId, EnemyState>;
  /** Path distance fields around each player (rebuilt from `s.pathOrigins`). */
  paths: Map<PlayerId, PathField>;
}

export const emit = (ctx: Ctx, e: SimEvent): void => {
  ctx.events.push(e);
};

/** Players taking part: joined, not left, connected. Disconnected ones are idle and invulnerable. */
export function activePlayers(s: SimState): PlayerState[] {
  return s.players.filter((p) => p.connected && !p.left);
}

/** Players still in the run (connected or within their reconnect grace). */
export function presentPlayers(s: SimState): PlayerState[] {
  return s.players.filter((p) => !p.left);
}

export function playerById(s: SimState, id: PlayerId): PlayerState | undefined {
  return s.players.find((p) => p.id === id);
}

export function nextId(s: SimState): EntityId {
  return s.nextId++;
}

/** Is (x, y) within `pad` of some active player's view? (legacy `Camera.sees`) */
export function seenByAny(s: SimState, x: number, y: number, pad: number): boolean {
  for (const p of s.players) {
    if (!p.connected || p.left) continue;
    if (Math.abs(x - p.x) < VIEW_W / 2 + pad && Math.abs(y - p.y) < VIEW_H / 2 + pad) return true;
  }
  return false;
}
