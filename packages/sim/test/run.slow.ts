// Opt-in 20-minute progression/endurance scenario: pnpm test:slow.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { createSim } from '../src/index.js';
import { botInputs, pickFirst } from './bots.js';

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
    const runEvents = new Set<string>();
    while (sim.state.time < 20 * 60 && !sim.ended) {
      pickFirst(sim);
      botInputs(sim);
      // This invulnerable progression fixture deliberately engages bosses. Pure kiting bots
      // can leave every boss alive indefinitely, suppressing all later run events; a balance
      // change must not turn those incidental paths into a false regression.
      const boss = sim.state.enemies.find((e) => e.boss && !e.dead);
      if (boss) {
        for (const p of sim.state.players) {
          const dx = boss.x - p.x;
          const dy = boss.y - p.y;
          const distance = Math.hypot(dx, dy);
          sim.setInput(p.id, {
            moveX: distance > 20 ? dx / distance : 0,
            moveY: distance > 20 ? dy / distance : 0,
          });
        }
      }
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.type === 'enemy-spawned' && e.boss && !e.legend) bossesSpawned++;
        if (e.type === 'run-event') runEvents.add(e.id);
        if (e.type === 'thief') runEvents.add('thief');
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
      // 2b
      'rift-opened',
      'rift-closed',
      'weather',
      'run-event',
      'thief',
      'trap',
    ]) {
      expect(kinds).toContain(k);
    }
    // A rift at least every 150 s after its predecessor is over (see rift.test.ts): 20 minutes
    // fit at least five.
    expect(s.rift.opened).toBeGreaterThanOrEqual(5);
    expect(runEvents.size).toBeGreaterThanOrEqual(2);
    const sum = sim.summary();
    expect(sum.players.length).toBe(4);
    expect(sum.players[0]!.rewardCoins).toBeGreaterThan(240); // ≥ 20 min / 5 s
    expect(sum.players[0]!.progress.defeats).toBe(s.team.kills);
  }, 120_000);
});
