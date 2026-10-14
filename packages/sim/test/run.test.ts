// A vulnerable bot run must end cleanly when everyone is down.
import { describe, expect, it } from 'vitest';
import { createSim } from '../src/index.js';
import { botStep } from './bots.js';

describe('full runs', () => {
  it('a vulnerable 2-player run ends cleanly when everyone is down', () => {
    const sim = createSim({
      seed: 11,
      players: [
        { id: 'a', dex: 25 },
        { id: 'b', dex: 4 },
      ],
    });
    while (!sim.ended && sim.state.time < 30 * 60) {
      botStep(sim);
      sim.drainEvents();
    }
    expect(sim.state.ended?.reason).toBe('all-down');
    const sum = sim.summary();
    expect(sum.players.every((p) => p.timesDown >= 1)).toBe(true);
    expect(sum.team.kills).toBeGreaterThan(0);
  }, 120_000);
});
