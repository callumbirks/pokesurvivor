import { describe, expect, it } from 'vitest';
import { facingOf, isAttacking } from '../src/index.js';
import { player, quietSim, spawnDummy } from './helpers.js';

const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('facing', () => {
  it('a player attacking while it walks away keeps facing its target, between casts too', () => {
    const sim = quietSim(1, { seed: 4 });
    const p = player(sim);
    // An enemy to the left; the player walks right, away from it, casting all along.
    spawnDummy(sim, p.x - 120, p.y);
    sim.setInput(p.id, { moveX: 1, moveY: 0 });
    let casts = 0;
    let checked = 0;
    for (let i = 0; i < 150; i++) {
      sim.step();
      casts += sim.drainEvents().filter((e) => e.type === 'cast' && e.playerId === p.id).length;
      if (casts === 0) continue;
      const attacking = isAttacking(sim.state.time, p);
      expect(attacking).toBe(true);
      const face = facingOf({ attacking, walking: p.walking, aim: p.aim, moveAngle: p.moveAngle });
      expect(p.walking).toBe(true);
      // It faces the enemy (left), not where it walks (right).
      expect(angleGap(face, Math.PI)).toBeLessThan(0.5);
      expect(angleGap(face, p.moveAngle)).toBeGreaterThan(2.5);
      checked++;
    }
    expect(casts).toBeGreaterThan(2);
    expect(checked).toBeGreaterThan(60);
  });

  it('faces where it walks once it stops attacking, and its aim when standing still', () => {
    expect(facingOf({ attacking: false, walking: true, aim: 0, moveAngle: 2 })).toBe(2);
    expect(facingOf({ attacking: false, walking: false, aim: 1, moveAngle: 2 })).toBe(1);
    expect(facingOf({ attacking: true, walking: true, aim: 1, moveAngle: 2 })).toBe(1);
  });
});
