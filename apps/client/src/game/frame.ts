// What one rendered frame shows: the snapshots interpolated ~100 ms in the past for everything
// but our own Pokémon, which is predicted (see net/predict.ts). The renderer and the HUD read this.
import {
  interpolateList,
  type BufferSample,
  type Game,
  type NetPickup,
  type NetPlayer,
  type PlayerDetail,
  type Snapshot,
} from '@pokesurvivor/netclient';
import { interpolate } from '@pokesurvivor/netclient';
import type { NetEnemy, NetField, NetHazard, NetProjectile } from '@pokesurvivor/netclient';

export interface Frame {
  game: Game;
  selfId: string;
  /** Local animation clock (s) and this frame's duration (s). */
  time: number;
  dt: number;
  /** The (fractional) server tick shown. */
  tick: number;
  /** The newest snapshot: HUD, choices, team, world records. */
  snap: Snapshot;
  players: NetPlayer[];
  enemies: NetEnemy[];
  projectiles: NetProjectile[];
  pickups: NetPickup[];
  fields: NetField[];
  hazards: NetHazard[];
  /** Our Pokémon (predicted position), or null if we're not in the game. */
  self: NetPlayer | null;
  selfDetail: PlayerDetail | null;
}

/** The interpolated view of a buffer sample, with our player at `selfPos`. */
export function buildFrame(
  game: Game,
  selfId: string,
  sample: BufferSample,
  latest: Snapshot,
  time: number,
  dt: number,
  selfPos: { x: number; y: number; walking: boolean; moveAngle: number } | null,
): Frame {
  const v = interpolate(sample);
  const players = v.players.map((p) => {
    if (p.id !== selfId) return p;
    // Our own Pokémon: the newest data (HP, flags), at the predicted position.
    const own = latest.players.find((q) => q.id === selfId) ?? p;
    return selfPos
      ? {
          ...own,
          x: selfPos.x,
          y: selfPos.y,
          walking: selfPos.walking,
          moveAngle: selfPos.moveAngle,
        }
      : own;
  });
  return {
    game,
    selfId,
    time,
    dt,
    tick: v.tick,
    snap: latest,
    players,
    enemies: v.enemies,
    projectiles: v.projectiles,
    pickups: interpolateList(sample.from.pickups, sample.to.pickups, sample.alpha),
    fields: sample.to.fields,
    hazards: sample.to.hazards,
    self: players.find((p) => p.id === selfId) ?? null,
    selfDetail: latest.details[selfId] ?? null,
  };
}
