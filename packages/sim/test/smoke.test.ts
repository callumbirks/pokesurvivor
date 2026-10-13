import { describe, expect, it } from 'vitest';
import { createSim } from '../src/index.js';
import { botStep } from './bots.js';

describe('smoke', () => {
  it('runs', () => {
    const players = [25, 4, 7, 1].map((dex, i) => ({ id: 'p' + i, dex }));
    const sim = createSim({ seed: 42, players, debug: { invulnerable: true } });
    const t0 = performance.now();
    let last = 0;
    while (!sim.ended && sim.state.time < 1200) {
      botStep(sim);
      sim.drainEvents();
      const s = sim.state;
      if (s.time - last >= 60) {
        last = s.time;
        process.stderr.write(
          JSON.stringify([
            Math.round(performance.now() - t0),
            't',
            s.time.toFixed(0),
            'lvl',
            s.team.level,
            'kills',
            s.team.kills,
            'boss',
            s.team.bosses,
            'en',
            s.enemies.length,
            'pk',
            s.pickups.length,
            'pr',
            s.projectiles.length,
            'f',
            s.fields.length,
            'hz',
            s.hazards.length,
            'chunks',
            Object.keys(s.world.broken).length,
          ]) + '\n',
        );
      }
    }
    const s = sim.state;
    process.stderr.write(
      JSON.stringify([
        s.ended,
        s.spawner.bossIndex,
        s.players.map(
          (p) =>
            p.moves.map((m) => m.id + m.level + (m.evolved ? '*' : '')).join(',') + ' ' + p.item,
        ),
      ]) + '\n',
    );
    expect(s.tick).toBeGreaterThan(0);
  }, 600000);
});
