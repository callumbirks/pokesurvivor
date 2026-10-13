// Scripted bots for headless tests: drift in a circle around the team, back away from nearby
// enemies, go to downed teammates, and take the first option of every choice.
import type { Sim } from '../src/index.js';

export function pickFirst(sim: Sim): void {
  for (const c of sim.state.pendingChoices.slice()) {
    if (c.kind === 'level-up') {
      sim.submitIntent(c.playerId, {
        type: 'pickCard',
        choiceId: c.id,
        cardId: c.options[0]?.id ?? '',
      });
    } else sim.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.found });
  }
}

export function botInputs(sim: Sim, periodTicks = 600): void {
  const s = sim.state;
  const alive = s.players.filter((p) => !p.left && !p.dead);
  const cx = alive.reduce((a, p) => a + p.x, 0) / (alive.length || 1);
  const cy = alive.reduce((a, p) => a + p.y, 0) / (alive.length || 1);
  s.players.forEach((p, i) => {
    if (p.left || p.dead) return;
    const a = (s.tick / periodTicks) * Math.PI * 2 + i * 1.7;
    let dx = Math.cos(a) * 0.6;
    let dy = Math.sin(a) * 0.6;
    for (const e of s.enemies) {
      const ex = p.x - e.x;
      const ey = p.y - e.y;
      const d = Math.hypot(ex, ey);
      if (d < 300 && d > 0) {
        dx += ((ex / d) * (300 - d)) / 40;
        dy += ((ey / d) * (300 - d)) / 40;
      }
    }
    const down = s.players.find((o) => o.dead && !o.left);
    const [tx, ty] = down ? [down.x, down.y] : [cx, cy];
    const td = Math.hypot(tx - p.x, ty - p.y);
    if (td > (down ? 10 : 260)) {
      dx += ((tx - p.x) / td) * (down ? 3 : 0.8);
      dy += ((ty - p.y) / td) * (down ? 3 : 0.8);
    }
    sim.setInput(p.id, { moveX: dx, moveY: dy });
  });
}

export function botStep(sim: Sim): void {
  pickFirst(sim);
  botInputs(sim);
  sim.step();
}

export function runFor(sim: Sim, seconds: number, onTick?: () => void): void {
  const until = sim.state.tick + Math.round(seconds * 30);
  while (sim.state.tick < until && !sim.ended) {
    botStep(sim);
    onTick?.();
  }
}
