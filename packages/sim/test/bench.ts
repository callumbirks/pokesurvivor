// Tick cost of a 4-player late-game run: `pnpm --filter @pokesurvivor/sim bench`.
//   1. a 20-minute run with scripted bots (enemy cap 64, bosses, projectiles, pickups)
//   2. the same run with extra enemies spawned past the cap (stress: 200, 400, 800 alive)
import { performance } from 'node:perf_hooks';
import { activePlayers } from '../src/ctx.js';
import { createSim, TICK_MS, type Sim } from '../src/index.js';
import { spawnOne } from '../src/spawner.js';
import { botStep } from './bots.js';

function measure(sim: Sim, ticks: number) {
  const times: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    botStep(sim);
    times.push(performance.now() - t0);
    sim.drainEvents();
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { mean, p50: at(0.5), p99: at(0.99), max: at(1) };
}

function fill(sim: Sim, n: number) {
  const players = activePlayers(sim.state);
  let guard = 0;
  while (sim.state.enemies.length < n && guard++ < n * 20) {
    const p = players[guard % players.length];
    if (p) spawnOne(sim.ctx, p, sim.state.time);
  }
}

const row = (label: string, sim: Sim, r: ReturnType<typeof measure>) =>
  console.log(
    `${label.padEnd(26)} enemies ${String(sim.state.enemies.length).padStart(4)}  projectiles ${String(sim.state.projectiles.length).padStart(4)}  pickups ${String(sim.state.pickups.length).padStart(4)}  ` +
      `mean ${r.mean.toFixed(2)} ms  p50 ${r.p50.toFixed(2)}  p99 ${r.p99.toFixed(2)}  max ${r.max.toFixed(2)}  (budget ${TICK_MS.toFixed(1)} ms)`,
  );

const sim = createSim({
  seed: 2026,
  players: [25, 4, 7, 1].map((dex, i) => ({ id: `bot${i}`, dex })),
  debug: { invulnerable: true },
});
const t0 = performance.now();
let ticks = 0;
while (sim.state.time < 20 * 60) {
  botStep(sim);
  sim.drainEvents();
  ticks++;
}
console.log(
  `20-minute 4-player run: ${ticks} ticks in ${((performance.now() - t0) / 1000).toFixed(1)} s ` +
    `(${((performance.now() - t0) / ticks).toFixed(3)} ms/tick average)`,
);
row('late game (cap)', sim, measure(sim, 900));
for (const n of [200, 400, 800]) {
  fill(sim, n);
  row(`stress, ${n} enemies`, sim, measure(sim, 300));
}
