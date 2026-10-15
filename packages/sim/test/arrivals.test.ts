import { describe, expect, it } from 'vitest';
import { DT } from '../src/constants.js';
import { TAU } from '../src/math.js';
import { updateEnemies } from '../src/enemies.js';
import { restoreSim } from '../src/index.js';
import { trackVelocities } from '../src/players.js';
import { arrivalAngle, rejoinPlayer, spawnOne, travelHeading } from '../src/spawner.js';
import { patchTuning, player, quietSim, steps } from './helpers.js';
import { spawnDummy } from './helpers.js';

describe('arrival direction history', () => {
  it('averages actual travel and ignores a brief input reversal, then follows a sustained turn', () => {
    const sim = quietSim();
    const p = player(sim);
    const cfg = sim.ctx.d.game.tuning.spawner.directionBias;
    const speed = Math.max(100, cfg.minSpeed * 4);
    const ticks = Math.ceil((cfg.smoothingSeconds * 3) / DT);
    for (let i = 0; i < ticks; i++) {
      p.x += speed * DT;
      trackVelocities(sim.ctx);
    }
    p.input.moveX = -1;
    expect(travelHeading(sim.ctx, p)).toBeCloseTo(0);
    for (let i = 0; i < 3; i++) {
      p.x -= speed * DT;
      trackVelocities(sim.ctx);
    }
    expect(p.travelVx).toBeGreaterThan(0);
    for (let i = 0; i < ticks; i++) {
      p.x -= speed * DT;
      trackVelocities(sim.ctx);
    }
    expect(p.travelVx).toBeLessThan(0);
    p.x += 1000;
    trackVelocities(sim.ctx);
    expect(p.travelVx).toBe(0);
    expect(p.travelVy).toBe(0);
  });

  it('uses a uniform RNG angle while stationary, even with a contrary input', () => {
    const sim = quietSim();
    const reference = quietSim();
    const p = player(sim);
    p.input.moveX = 1;
    for (let i = 0; i < 50; i++) expect(arrivalAngle(sim.ctx, p)).toBe(reference.ctx.rand() * TAU);
  });

  it('keeps ordinary placement retries in the selected hemisphere at both share extremes', () => {
    for (const aheadShare of [0, 1]) {
      const sim = quietSim();
      const p = player(sim);
      patchTuning(sim, 'spawner', {
        directionBias: { ...sim.ctx.d.game.tuning.spawner.directionBias, aheadShare },
      });
      p.travelVx = Math.max(100, sim.ctx.d.game.tuning.spawner.directionBias.minSpeed * 4);
      p.travelVy = p.travelVx;
      let placed = 0;
      for (let i = 0; i < 60; i++) {
        sim.state.enemies = [];
        const e = spawnOne(sim.ctx, p, 0);
        if (!e) continue;
        placed++;
        const dot = (e.x - p.x) * p.travelVx + (e.y - p.y) * p.travelVy;
        expect(aheadShare === 0 ? dot <= 0 : dot >= 0).toBe(true);
      }
      expect(placed).toBeGreaterThan(0);
    }
  });

  it('rotates the same sampled angle with each target’s own history', () => {
    const a = quietSim(2),
      b = quietSim(2);
    player(a).travelVx = 100;
    player(a, 1).travelVx = -100;
    player(b).travelVx = 100;
    player(b, 1).travelVx = -100;
    for (let i = 0; i < 50; i++)
      expect(
        Math.cos(arrivalAngle(a.ctx, player(a)) - arrivalAngle(b.ctx, player(b, 1))),
      ).toBeCloseTo(-1);
  });

  it.each([0, 1])('keeps catch-up retries in the chosen half at aheadShare %i', (aheadShare) => {
    const sim = quietSim();
    patchTuning(sim, 'stragglers', { aheadShare });
    const p = player(sim);
    const e = spawnDummy(sim, 0, 0);
    e.flying = true;
    const half = (sim.ctx.d.game.tuning.stragglers.rearArcDegrees * Math.PI) / 360;
    const speed = Math.max(100, sim.ctx.d.game.tuning.spawner.directionBias.minSpeed * 4);
    for (let i = 0; i < 80; i++) {
      const a = (i * Math.PI) / 40;
      p.travelVx = Math.cos(a) * speed;
      p.travelVy = Math.sin(a) * speed;
      expect(rejoinPlayer(sim.ctx, e, p)).toBe(true);
      const dot = (e.x - p.x) * Math.cos(a) + (e.y - p.y) * Math.sin(a);
      if (aheadShare === 1) expect(dot).toBeGreaterThanOrEqual(0);
      else
        expect(dot).toBeLessThanOrEqual(-Math.cos(half) * Math.hypot(e.x - p.x, e.y - p.y) + 1e-7);
    }
  });

  it('keeps stationary catch-up uniform independently of the forward-share knob', () => {
    const a = quietSim(),
      b = quietSim();
    patchTuning(a, 'stragglers', { aheadShare: 0 });
    patchTuning(b, 'stragglers', { aheadShare: 1 });
    const ea = spawnDummy(a, 0, 0),
      eb = spawnDummy(b, 0, 0);
    ea.flying = eb.flying = true;
    for (let i = 0; i < 40; i++) {
      expect(rejoinPlayer(a.ctx, ea, player(a))).toBe(rejoinPlayer(b.ctx, eb, player(b)));
      expect([ea.x, ea.y]).toEqual([eb.x, eb.y]);
    }
  });

  it('waits the unseen grace even at extreme distance and resets it when seen', () => {
    const sim = quietSim();
    patchTuning(sim, 'stragglers', { aheadShare: 0 });
    const p = player(sim);
    p.travelVx = 100;
    const e = spawnDummy(sim, p.x - 2000, p.y);
    e.flying = true;
    const delay = sim.ctx.d.game.tuning.stragglers.unseenSeconds;
    e.lagT = delay - DT * 2;
    const x = e.x;
    updateEnemies(sim.ctx);
    expect(e.x).toBe(x);
    updateEnemies(sim.ctx);
    updateEnemies(sim.ctx);
    expect(e.x).not.toBe(x);
    expect(e.x).toBeLessThanOrEqual(p.x);
    e.x = p.x - 100;
    e.lagT = delay;
    updateEnemies(sim.ctx);
    expect(e.lagT).toBe(0);
  });

  it('restores nonzero history exactly, migrates absent fields and continues deterministically', () => {
    const sim = quietSim();
    sim.setInput(player(sim).id, { moveX: 1, moveY: 0 });
    steps(sim, 30);
    expect(player(sim).travelVx).toBeGreaterThan(0);
    sim.drainEvents();
    const restored = restoreSim(structuredClone(sim.state));
    expect(restored.hash()).toBe(sim.hash());
    for (let i = 0; i < 90; i++) {
      sim.step();
      restored.step();
      expect(restored.drainEvents()).toEqual(sim.drainEvents());
    }
    expect(restored.hash()).toBe(sim.hash());
    const old = structuredClone(sim.state);
    for (const p of old.players) {
      Reflect.deleteProperty(p, 'travelVx');
      Reflect.deleteProperty(p, 'travelVy');
    }
    const migrated = restoreSim(old);
    expect(player(migrated).travelVx).toBe(0);
    expect(player(migrated).travelVy).toBe(0);
  });
});
