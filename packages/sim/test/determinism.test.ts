import { describe, expect, it } from 'vitest';
import { createSim, restoreSim, type Sim, type SimConfig } from '../src/index.js';
import type { SimState } from '../src/state.js';
import { botInputs, pickFirst } from './bots.js';

const config = (seed: number): SimConfig => ({
  seed,
  players: [
    { id: 'a', dex: 25 },
    { id: 'b', dex: 6, upgrades: { attack: 3, crit: 5 } },
    { id: 'c', dex: 131 },
  ],
});

/** Bot inputs, plus a disconnect and a reconnect, so every API path is in the replay. */
function drive(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    pickFirst(sim);
    botInputs(sim);
    const t = sim.state.tick;
    if (t === 400) sim.setConnected('c', false);
    if (t === 700) sim.setConnected('c', true);
    if (t % 97 === 0) sim.setInput('a', { moveX: 0.3, moveY: -1, slot: (t / 97) % 2 });
    sim.step();
    sim.drainEvents();
  }
}

describe('determinism', () => {
  it('same seed and inputs give the same state hash', () => {
    const a = createSim(config(99));
    const b = createSim(config(99));
    expect(a.hash()).toBe(b.hash());
    for (let k = 0; k < 6; k++) {
      drive(a, 500);
      drive(b, 500);
      expect(a.hash()).toBe(b.hash());
    }
    expect(a.state.team.kills).toBeGreaterThan(0);
  });

  it('a different seed diverges', () => {
    const a = createSim(config(1));
    const b = createSim(config(2));
    drive(a, 300);
    drive(b, 300);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('a JSON snapshot restores into a sim that continues identically', () => {
    const a = createSim(config(5));
    drive(a, 2000);
    const snap = JSON.parse(JSON.stringify(a.state)) as SimState;
    const b = restoreSim(snap);
    expect(b.hash()).toBe(a.hash());
    drive(a, 1500);
    drive(b, 1500);
    expect(b.hash()).toBe(a.hash());
  });
});
