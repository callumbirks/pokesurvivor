// Whole runs with scripted bots: a 20-minute 4-player game to completion, and a realistic one
// (bots can die) that must end cleanly.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { createSim } from '../src/index.js';
import { botStep } from './bots.js';

describe('full runs', () => {
  it('4 players, 20 minutes: completes with sane progression', () => {
    const sim = createSim({
      seed: 2026,
      players: [25, 4, 7, 1].map((dex, i) => ({ id: `bot${i}`, dex })),
      // The bots walk in circles and take the first card: they can't survive legacy co-op
      // difficulty, so this run checks progression, not their skill.
      debug: { invulnerable: true },
    });
    let bossesSpawned = 0;
    let maxEnemies = 0;
    const kinds = new Set<string>();
    while (sim.state.time < 20 * 60 && !sim.ended) {
      botStep(sim);
      for (const e of sim.drainEvents()) {
        if (e.type === 'enemy-spawned' && e.boss) bossesSpawned++;
        kinds.add(e.type);
      }
      maxEnemies = Math.max(maxEnemies, sim.state.enemies.length);
    }
    const s = sim.state;
    expect(sim.ended).toBe(false);
    expect(s.time).toBeGreaterThanOrEqual(20 * 60);
    expect(s.team.level).toBeGreaterThanOrEqual(6);
    expect(s.team.kills).toBeGreaterThan(150);
    expect(bossesSpawned).toBe(5); // 3, 6, 9, 12 and 15 minutes
    expect(s.team.bosses).toBeGreaterThanOrEqual(1);
    // The cap, plus summoned minions' margin and the bosses.
    expect(maxEnemies).toBeLessThanOrEqual(simData().game.tuning.spawner.cap + 15 + bossesSpawned);
    expect(s.world.biome).toBe(5); // a new biome every 4 minutes
    for (const p of s.players) expect(p.moves.length).toBeGreaterThanOrEqual(2);
    for (const k of [
      'cast',
      'enemy-hurt',
      'enemy-died',
      'pickup',
      'level-up',
      'choice-resolved',
      'biome',
      'say',
    ]) {
      expect(kinds).toContain(k);
    }
    const sum = sim.summary();
    expect(sum.players.length).toBe(4);
    expect(sum.players[0]!.rewardCoins).toBeGreaterThan(240); // ≥ 20 min / 5 s
    expect(sum.players[0]!.progress.defeats).toBe(s.team.kills);
  }, 120_000);

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
