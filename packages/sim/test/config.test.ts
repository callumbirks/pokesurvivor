// Live tuning: each sim runs on the game data it was created with, not a global one.
import {
  defaultTunables,
  gameDataWith,
  loadGameData,
  type TunableConfig,
} from '@pokesurvivor/data';
import { describe, expect, it } from 'vitest';
import { createSim, playerStats, restoreSim, type SimState } from '../src/index.js';
import { quietSim, player } from './helpers.js';

const base = loadGameData();

/** The built-in data with a different prestige bonus (any tuning change would do). */
function tuned(): ReturnType<typeof gameDataWith> {
  const cfg = JSON.parse(JSON.stringify(defaultTunables(base))) as TunableConfig;
  cfg.tuning.prestige.perStar.hp *= 2;
  cfg.tuning.defense.max /= 2;
  return gameDataWith(base, cfg);
}

describe('game data per sim', () => {
  it('uses the built-in data by default', () => {
    expect(quietSim().ctx.d.game).toBe(base);
  });

  it('runs on the data it was created with, and keeps it on restore', () => {
    const data = tuned();
    const players = [{ id: 'p0', dex: 25, prestige: 2 }];
    const sim = createSim({ seed: 3, players, data });
    const plain = createSim({ seed: 3, players });
    expect(sim.ctx.d.game).toBe(data);
    expect(sim.ctx.d).not.toBe(plain.ctx.d);
    // Stats built from the tuned prestige bonus differ from the default run's.
    expect(player(sim).maxHp).not.toBe(player(plain).maxHp);
    // The views over a bare state (the stats panel snapshots send) read the sim's data too.
    player(sim).defense = player(plain).defense = 1000;
    expect(playerStats(sim.state, player(sim)).defense).toBe(data.tuning.defense.max);
    expect(playerStats(plain.state, player(plain)).defense).toBe(base.tuning.defense.max);

    const restored = restoreSim(JSON.parse(JSON.stringify(sim.state)) as SimState, data);
    expect(restored.ctx.d.game).toBe(data);
    expect(restored.hash()).toBe(sim.hash());
    for (let i = 0; i < 60; i++) {
      sim.step();
      restored.step();
    }
    expect(restored.hash()).toBe(sim.hash());
  });

  it('builds the sim data once per game data', () => {
    const data = tuned();
    const a = createSim({ seed: 1, players: [{ id: 'a', dex: 25 }], data });
    const b = createSim({ seed: 2, players: [{ id: 'b', dex: 25 }], data });
    expect(a.ctx.d).toBe(b.ctx.d);
  });
});
