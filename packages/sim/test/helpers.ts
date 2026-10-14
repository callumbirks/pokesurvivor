// Building blocks for system tests: a sim with no spawner, hand-placed enemies, chosen moves.
import { addEnemy, createEnemy, rebuildGrid } from '../src/enemies.js';
import { newMove } from '../src/moves.js';
import { clearOrbs } from '../src/projectiles.js';
import { createSim, type PlayerConfig, type Sim, type SimConfig } from '../src/index.js';
import type { EnemyDef, EnemyState, PlayerState } from '../src/state.js';

/** Rattata: a plain Normal type (×1 from almost everything). */
export const DUMMY_DEX = 19;

export function quietSim(
  players: number | PlayerConfig[] = 1,
  config: Partial<SimConfig> = {},
): Sim {
  const list =
    typeof players === 'number'
      ? Array.from({ length: players }, (_, i) => ({ id: `p${i}`, dex: 25 }))
      : players;
  return createSim({
    seed: 7,
    players: list,
    ...config,
    debug: { noSpawns: true, ...config.debug },
  });
}

export const player = (sim: Sim, i = 0): PlayerState => {
  const p = sim.state.players[i];
  if (!p) throw new Error(`no player ${i}`);
  return p;
};

/** A still, harmless enemy with lots of HP (unless overridden). */
export function spawnDummy(
  sim: Sim,
  x: number,
  y: number,
  def: Partial<EnemyDef> = {},
  hp = 100000,
): EnemyState {
  const d: EnemyDef = { dex: DUMMY_DEX, behavior: 'chase', hp, speed: 0, damage: 0, xp: 1, ...def };
  const e = addEnemy(sim.ctx, createEnemy(sim.ctx, d, x, y, { hp: 1, speed: 1, damage: 1 }));
  rebuildGrid(sim.ctx);
  return e;
}

/** Replaces a player's moves with a single one. */
export function giveMove(sim: Sim, p: PlayerState, id: string, level = 1): void {
  clearOrbs(sim.ctx, p.id);
  p.moves = [newMove(sim.ctx, id, level)];
  p.slots = [[id]];
  p.active = 0;
}

export function steps(sim: Sim, n: number): void {
  for (let i = 0; i < n; i++) sim.step();
}

export const seconds = (s: number): number => Math.round(s * 30);

/** Total damage the events report for an enemy. */
export function damageTo(events: ReturnType<Sim['drainEvents']>, id: number): number {
  let sum = 0;
  for (const e of events)
    if (e.type === 'enemy-hurt' && e.id === id && !e.shielded) sum += e.amount;
  return sum;
}

/** Patch tuning for one sim's branch fixture without mutating the shared loaded data. */
export function patchTuning<K extends keyof Sim['ctx']['d']['game']['tuning']>(
  sim: Sim,
  key: K,
  patch: Partial<Sim['ctx']['d']['game']['tuning'][K]>,
): void {
  const d = sim.ctx.d;
  sim.ctx.d = {
    ...d,
    game: {
      ...d.game,
      tuning: { ...d.game.tuning, [key]: { ...d.game.tuning[key], ...patch } },
    },
  };
}

/** Keep automatic ambient systems outside a focused test's observation window. */
export function postponeAmbientSystems(sim: Sim, duration: number): void {
  sim.state.rift.checkT = duration + 1;
  sim.state.weather.checkT = duration + 1;
  sim.state.events.nextT = duration + 1;
  sim.state.events.thiefT = duration + 1;
}
