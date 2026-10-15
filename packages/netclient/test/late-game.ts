// A 4-player late game for measuring snapshots: scripted bots that stay together (the worst case
// for interest management: every enemy is near every player) and pick the first card.
import { createSim, type Sim } from '@pokesurvivor/sim';
import { firstOption } from '../src/choices.js';

export function botStep(sim: Sim): void {
  const s = sim.state;
  for (const c of s.pendingChoices.slice()) {
    const intent = firstOption(c);
    if (intent) sim.submitIntent(c.playerId, intent);
  }
  const alive = s.players.filter((p) => !p.left);
  const cx = alive.reduce((a, p) => a + p.x, 0) / (alive.length || 1);
  const cy = alive.reduce((a, p) => a + p.y, 0) / (alive.length || 1);
  s.players.forEach((p, i) => {
    const a = (s.tick / 900) * Math.PI * 2;
    let dx = Math.cos(a) * 0.7;
    let dy = Math.sin(a) * 0.7;
    const d = Math.hypot(cx - p.x, cy - p.y);
    if (d > 80) {
      dx += ((cx - p.x) / d) * 0.6;
      dy += ((cy - p.y) / d) * 0.6;
    }
    dx += Math.cos(i * 1.7 + s.tick / 50) * 0.2;
    sim.setInput(p.id, { moveX: dx, moveY: dy });
  });
  sim.step();
}

/**
 * A sim `minutes` into a 4-player run (invulnerable bots, so it gets there). `rifts: false` keeps
 * it on the map with its crowd (no rift opens, so it can't be in an arena).
 */
export function lateGame(minutes: number, seed = 2026, opts: { rifts?: boolean } = {}): Sim {
  const sim = createSim({
    seed,
    players: [25, 4, 7, 1].map((dex, i) => ({ id: `p${i}`, dex })),
    debug: { invulnerable: true },
  });
  if (opts.rifts === false) sim.state.rift.checkT = 1e9;
  while (sim.state.time < minutes * 60) {
    botStep(sim);
    sim.drainEvents();
  }
  return sim;
}
