import { describe, expect, it } from 'vitest';
import { WorldView, moveSpeedOf, propsInRect, terrainRaw, type MovingBody } from '../src/index.js';
import { player, quietSim } from './helpers.js';

describe('WorldView', () => {
  it('moves a body exactly like the sim moves its player (client prediction)', () => {
    const sim = quietSim(1, { seed: 99 });
    const p = player(sim);
    const view = new WorldView(sim.state.world.seed);
    const body: MovingBody = {
      x: p.x,
      y: p.y,
      r: p.r,
      vx: p.vx,
      vy: p.vy,
      types: [...p.types],
      inLiquid: p.inLiquid,
      walking: p.walking,
      moveAngle: p.moveAngle,
    };
    // Walk in a few directions for long enough to hit walls, props and water on this map.
    for (let i = 0; i < 1500; i++) {
      if (sim.state.pendingChoices.length) break;
      const a = Math.floor(i / 120) * 1.3;
      const input = { moveX: Math.cos(a), moveY: Math.sin(a) };
      const speed = moveSpeedOf(sim.ctx, p);
      view.setRecords(sim.state.world as unknown as Record<string, Record<string, number>>);
      sim.setInput(p.id, input);
      sim.step();
      view.move(body, input.moveX, input.moveY, speed);
      expect(body.x).toBeCloseTo(p.x, 6);
      expect(body.y).toBeCloseTo(p.y, 6);
      expect(body.inLiquid).toBe(p.inLiquid);
    }
    expect(Math.hypot(p.x, p.y)).toBeGreaterThan(300);
  });

  it('matches the sim terrain and props, and forgets broken props', () => {
    const sim = quietSim(1, { seed: 5 });
    const view = new WorldView(5);
    for (let ty = -40; ty < 40; ty += 3)
      for (let tx = -40; tx < 40; tx += 3)
        expect(view.terrain(tx, ty)).toBe(terrainRaw(5, tx, ty, null));
    const props = view.propsInRect(-2000, -2000, 2000, 2000);
    expect(props.length).toBe(propsInRect(sim.ctx, -2000, -2000, 2000, 2000).length);
    const first = props.find((q) => q.destructible);
    if (!first) throw new Error('no breakable prop near the start');
    view.setRecords({ broken: { [first.key]: 1 } });
    expect(view.propsInRect(-2000, -2000, 2000, 2000).some((q) => q.key === first.key)).toBe(false);
    view.setRecords({ broken: {} });
    expect(view.propsInRect(-2000, -2000, 2000, 2000).some((q) => q.key === first.key)).toBe(true);
  });
});
