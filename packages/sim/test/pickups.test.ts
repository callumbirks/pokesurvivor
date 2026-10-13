import { describe, expect, it } from 'vitest';
import { hurtEnemy } from '../src/enemies.js';
import { dropPickup, dropXp } from '../src/pickups.js';
import { simData } from '../src/data.js';
import { player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

describe('pickups', () => {
  it('sit still until inside the magnet radius, then fly to the player', () => {
    const sim = quietSim();
    const p = player(sim);
    dropPickup(sim.ctx, 'coin', p.x + p.magnet + 40, p.y, 3);
    steps(sim, seconds(2));
    expect(sim.state.pickups.length).toBe(1);
    dropPickup(sim.ctx, 'coin', p.x + p.magnet - 10, p.y, 4);
    steps(sim, seconds(1));
    expect(sim.state.pickups.length).toBe(1);
    expect(sim.state.team.coins).toBe(4);
  });

  it('XP goes to the team; a magnet pulls everything', () => {
    const sim = quietSim();
    const p = player(sim);
    dropXp(sim.ctx, p.x + 400, p.y, 10);
    dropPickup(sim.ctx, 'magnet', p.x + 5, p.y);
    steps(sim, seconds(3));
    expect(sim.state.team.xp + (sim.state.team.level > 1 ? 1 : 0)).toBeGreaterThan(0);
    expect(sim.state.pickups.filter((q) => q.kind === 'xp').length).toBe(0);
  });

  it("heal: 30% of the collector's max HP; tickets count for the team", () => {
    const sim = quietSim();
    const p = player(sim);
    p.hp = 10;
    p.regen = 0;
    dropPickup(sim.ctx, 'heal', p.x + 5, p.y);
    dropPickup(sim.ctx, 'ticket', p.x + 5, p.y, 1);
    dropPickup(sim.ctx, 'ticket10', p.x + 5, p.y, 1);
    steps(sim, 3);
    expect(p.hp).toBeCloseTo(10 + p.maxHp * 0.3);
    expect(sim.state.team).toMatchObject({ tickets: 1, tickets10: 1 });
  });

  it('bomb: hurts every enemy the collector can see', () => {
    const sim = quietSim();
    const p = player(sim);
    const near = spawnDummy(sim, p.x + 300, p.y);
    const far = spawnDummy(sim, p.x + 900, p.y);
    dropPickup(sim.ctx, 'bomb', p.x + 5, p.y);
    steps(sim, 3);
    expect(near.hp).toBe(near.maxHp - (60 + 14));
    expect(far.hp).toBe(far.maxHp);
  });

  it('merge the oldest XP gems past the cap', () => {
    const sim = quietSim();
    const max = simData().game.tuning.pickups.max;
    for (let i = 0; i < max + 10; i++) dropPickup(sim.ctx, 'xp', 2000 + i, 2000, 1);
    expect(sim.state.pickups.length).toBe(max);
    expect(sim.state.pickups.reduce((a, q) => a + q.value, 0)).toBe(max + 10);
  });

  it('a boss drops coins, an item, big XP gems, a heal and a magnet', () => {
    const sim = quietSim();
    const e = spawnDummy(sim, 1000, 1000, {}, 1);
    e.boss = true;
    e.xp = 140;
    hurtEnemy(sim.ctx, e, 10);
    const kinds = sim.state.pickups.map((q) => q.kind);
    expect(kinds.filter((k) => k === 'coin').length).toBe(10);
    expect(kinds.filter((k) => k === 'item').length).toBe(1);
    expect(kinds.filter((k) => k === 'xp-big').length).toBe(14);
    expect(kinds).toContain('heal');
    expect(kinds).toContain('magnet');
    steps(sim, 1);
    expect(sim.state.team.bosses).toBe(1);
  });
});
