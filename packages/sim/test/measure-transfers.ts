// Manual late-game measurement; kept outside the default test suite.
// pnpm --filter @pokesurvivor/sim exec tsx test/measure-transfers.ts
import { createSim, restoreSim } from '../src/index.js';
import { pickFirst } from './bots.js';

for (const seed of [7, 2026, 99]) {
  const sim = createSim({
    seed,
    players: [
      { id: 'a', dex: 25 },
      { id: 'b', dex: 4 },
    ],
    debug: { invulnerable: true },
  });
  sim.state.players[0]!.x = -2000;
  sim.state.players[1]!.x = 2000;
  for (const minute of [8, 10, 15]) {
    while (sim.state.time < minute * 60) {
      pickFirst(sim);
      // Each player runs around their own distant clearing with normal attacks/upgrades.
      for (const [i, p] of sim.state.players.entries()) {
        const angle = sim.state.time / 10 + i * Math.PI;
        const dx = (i === 0 ? -2000 : 2000) + Math.cos(angle) * 350 - p.x;
        const dy = Math.sin(angle) * 350 - p.y;
        const distance = Math.hypot(dx, dy);
        sim.setInput(p.id, { moveX: dx / (distance || 1), moveY: dy / (distance || 1) });
      }
      sim.step();
      sim.drainEvents();
    }
    const trial = restoreSim(structuredClone(sim.state));
    const [source, survivor] = trial.state.players;
    if (!source || !survivor) throw new Error('missing player');
    const horde = trial.state.enemies.filter(
      (e) =>
        !e.boss &&
        !e.shiny &&
        !e.legend &&
        Math.hypot(e.x - source.x, e.y - source.y) <
          Math.hypot(e.x - survivor.x, e.y - survivor.y) &&
        Math.hypot(e.x - survivor.x, e.y - survivor.y) > 1400,
    );
    const ids = new Set(horde.map((e) => e.id));
    trial.state.config.noSpawns = true;
    trial.state.projectiles = [];
    trial.state.fields = [];
    trial.state.hazards = [];
    trial.state.pickups = [];
    trial.state.pendingChoices = [];
    trial.state.pendingLevels = 0;
    for (const p of trial.state.players) {
      p.moves = [];
      p.smoothVx = p.smoothVy = p.vx = p.vy = 0;
      trial.setInput(p.id, { moveX: 0, moveY: 0 });
    }
    source.dead = true;
    source.hp = 0;
    const near: number[] = [];
    let ticks = 0;
    let completedAt: number | null = null;
    for (const second of [1, 5, 10, 20]) {
      while (ticks < second * 30) {
        trial.step();
        trial.drainEvents();
        ticks++;
        if (
          completedAt === null &&
          !trial.state.enemies.some((e) => ids.has(e.id) && e.transferFromId !== null)
        )
          completedAt = ticks / 30;
      }
      near.push(
        trial.state.enemies.filter(
          (e) => ids.has(e.id) && Math.hypot(e.x - survivor.x, e.y - survivor.y) < 1200,
        ).length,
      );
    }
    console.log(
      JSON.stringify({
        seed,
        minute,
        total: sim.state.enemies.length,
        horde: horde.length,
        near,
        removed: horde.length - trial.state.enemies.filter((e) => ids.has(e.id)).length,
        completedAt,
      }),
    );
  }
}
