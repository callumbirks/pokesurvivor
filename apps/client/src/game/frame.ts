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
  // Our orbs circle our Pokémon: they move with its predicted position, not ~100 ms behind it.
  const drawn = players.find((p) => p.id === selfId);
  const past = v.players.find((p) => p.id === selfId);
  const dx = drawn && past ? drawn.x - past.x : 0;
  const dy = drawn && past ? drawn.y - past.y : 0;
  const projectiles =
    drawn && (dx || dy)
      ? v.projectiles.map((pr) =>
          pr.orb && pr.ownerIndex === drawn.index ? { ...pr, x: pr.x + dx, y: pr.y + dy } : pr,
        )
      : v.projectiles;
  return {
    game,
    selfId,
    time,
    dt,
    tick: v.tick,
    snap: latest,
    players,
    enemies: v.enemies,
    projectiles,
    pickups: interpolateList(sample.from.pickups, sample.to.pickups, sample.alpha),
    fields: interpolateFields(sample.from.fields, sample.to.fields, sample.alpha),
    hazards: sample.to.hazards,
    self: players.find((p) => p.id === selfId) ?? null,
    selfDetail: latest.details[selfId] ?? null,
  };
}

/** Fields stay put; their timers (a meteor's fall, a mine's arming) are interpolated. */
function interpolateFields(from: readonly NetField[], to: readonly NetField[], alpha: number) {
  if (from === to || alpha === 0) return [...to];
  const before = new Map(from.map((f) => [f.id, f]));
  return to.map((f) => {
    const a = before.get(f.id);
    if (!a) return f;
    return {
      ...f,
      arm: a.arm + (f.arm - a.arm) * alpha,
      progress: a.progress + (f.progress - a.progress) * alpha,
    };
  });
}
