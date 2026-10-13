import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { equip } from '../src/items.js';
import { addMove } from '../src/moves.js';
import { hurtPlayer } from '../src/players.js';
import { damageTo, giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const d = simData();

describe('held items', () => {
  it('apply their stat effects while held and undo them on swap', () => {
    const sim = quietSim();
    const p = player(sim);
    const stats = [
      'attackMul',
      'speedMul',
      'cooldownMul',
      'xpMul',
      'coinMul',
      'magnet',
      'damageReduction',
      'regen',
    ] as const;
    const before = Object.fromEntries(stats.map((k) => [k, p[k]]));
    for (const it of d.game.items) {
      equip(sim.ctx, p, it.id);
      for (const e of it.effects) expect(p[e.stat], it.id).not.toBe(before[e.stat]);
    }
    equip(sim.ctx, p, null);
    for (const k of stats) expect(p[k]).toBeCloseTo(before[k] ?? NaN);
  });

  it('Leftovers: 1.5% max HP per second', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'leftovers');
    p.hp = 10;
    steps(sim, seconds(1));
    expect(p.hp).toBeCloseTo(10 + p.maxHp * 0.015, 0);
  });

  it("Choice Band: +40% damage, and the move can't be switched", () => {
    const sim = quietSim();
    const p = player(sim);
    addMove(sim.ctx, p, 'tackle');
    const atk = p.attackMul;
    equip(sim.ctx, p, 'choice-band');
    expect(p.attackMul).toBeCloseTo(atk * 1.4);
    const slot = p.active;
    sim.setInput(p.id, { moveX: 0, moveY: 0, slot: slot === 0 ? 1 : 0 });
    steps(sim, 1);
    expect(p.active).toBe(slot);
    expect(sim.drainEvents().some((e) => e.type === 'slot-locked')).toBe(true);
  });

  it('Focus Sash: survive a fatal hit with 1 HP, once a minute', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'focus-sash');
    hurtPlayer(sim.ctx, p, 9999, null);
    expect(p.dead).toBe(false);
    expect(p.hp).toBe(1);
    p.invuln = 0;
    hurtPlayer(sim.ctx, p, 9999, null);
    expect(p.dead).toBe(true);
  });

  it('Shell Bell: heals from damage dealt, at most 4 HP/s', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'shell-bell');
    giveMove(sim, p, 'tackle');
    spawnDummy(sim, p.x + 30, p.y);
    p.hp = 20;
    steps(sim, seconds(1));
    expect(p.hp).toBeGreaterThan(20);
    expect(p.hp).toBeLessThanOrEqual(24.01);
  });

  it('Life Orb: each cast costs 1% max HP but never knocks you out (legacy behaviour)', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'life-orb');
    giveMove(sim, p, 'tackle');
    spawnDummy(sim, p.x + 30, p.y);
    p.hp = 3;
    p.regen = 0;
    steps(sim, seconds(3));
    expect(p.hp).toBe(1);
    expect(p.dead).toBe(false);
  });

  it('Rocky Helmet: enemies that touch you get hurt', () => {
    const sim = quietSim(1, { debug: { invulnerable: true } });
    const p = player(sim);
    equip(sim.ctx, p, 'rocky-helmet');
    giveMove(sim, p, 'swords-dance');
    const e = spawnDummy(sim, p.x + 5, p.y, { damage: 5 });
    sim.drainEvents();
    steps(sim, 1);
    expect(damageTo(sim.drainEvents(), e.id)).toBe(15 + 4 * sim.state.team.level);
  });

  it('Assault Vest and Choice Scarf change defense and speed', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'assault-vest');
    expect(p.damageReduction).toBeCloseTo(0.2);
    equip(sim.ctx, p, 'choice-scarf');
    expect(p.damageReduction).toBeCloseTo(0);
    expect(p.speedMul).toBeCloseTo(1.35);
  });
});
