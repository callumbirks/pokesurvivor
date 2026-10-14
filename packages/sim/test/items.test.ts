import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { equip } from '../src/items.js';
import { openChoice } from '../src/choices.js';
import { addMove, newMove } from '../src/moves.js';
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
      for (const e of it.effects) {
        const base = before[e.stat]!;
        const expected =
          e.op === 'mul' ? base * e.value : base + e.value * (e.perMaxHp ? p.maxHp : 1);
        expect(p[e.stat], it.id).toBeCloseTo(expected);
      }
    }
    equip(sim.ctx, p, null);
    for (const k of stats) expect(p[k]).toBeCloseTo(before[k] ?? NaN);
  });

  it('Leftovers: regenerates the configured HP per second', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'leftovers');
    p.hp = 10;
    steps(sim, seconds(1));
    expect(p.hp).toBeCloseTo(
      Math.min(p.maxHp, 10 + p.maxHp * d.item('leftovers').effects[0]!.value),
      0,
    );
  });

  it('Choice Band: applies its damage modifier and locks move switching', () => {
    const sim = quietSim();
    const p = player(sim);
    addMove(sim.ctx, p, 'tackle');
    const atk = p.attackMul;
    equip(sim.ctx, p, 'choice-band');
    expect(p.attackMul).toBeCloseTo(atk * d.item('choice-band').effects[0]!.value);
    const slot = p.active;
    sim.setInput(p.id, { moveX: 0, moveY: 0, slot: slot === 0 ? 1 : 0 });
    steps(sim, 1);
    expect(p.active).toBe(slot);
    expect(sim.drainEvents().some((e) => e.type === 'slot-locked')).toBe(true);
  });

  it('Focus Sash: survives one fatal hit, then waits for its cooldown', () => {
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

  it('Shell Bell: heals from damage dealt up to its configured bank', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'shell-bell');
    giveMove(sim, p, 'tackle');
    spawnDummy(sim, p.x + 30, p.y);
    p.hp = 20;
    steps(sim, seconds(1));
    expect(p.hp).toBeGreaterThan(20);
    expect(p.hp).toBeLessThanOrEqual(20 + (d.item('shell-bell').params?.maxBankedHeal ?? 0) + 0.01);
  });

  describe('Life Orb', () => {
    const params = d.item('life-orb').params ?? {};
    const rate = params.drainPerSecond ?? 0;
    const floor = params.drainFloor ?? 0;
    // Untargeted moves by cooldown: the fastest and slowest caster cost the same per second.
    const shots = d.game.moves.moves
      .filter((m) => ['projectile', 'nova', 'beam'].includes(m.kind) && !m.stats.poison)
      .sort((a, b) => (a.stats.cooldown ?? 0) - (b.stats.cooldown ?? 0));
    const fast = shots[0]!;
    const slow = shots[shots.length - 1]!;

    function orbSim(move: string) {
      const sim = quietSim();
      const p = player(sim);
      equip(sim.ctx, p, 'life-orb');
      giveMove(sim, p, move);
      p.regen = 0;
      spawnDummy(sim, p.x + 60, p.y);
      return { sim, p };
    }

    it('applies its damage modifier and has drain params instead of a per-cast cost', () => {
      expect(params.hpCostPerCast).toBeUndefined();
      const sim = quietSim();
      const p = player(sim);
      const before = p.attackMul;
      equip(sim.ctx, p, 'life-orb');
      expect(p.attackMul).toBeCloseTo(before * d.item('life-orb').effects[0]!.value);
    });

    it('drains per second while attacking: a fast move costs the same as a slow one', () => {
      expect((fast.stats.cooldown ?? 0) * 3).toBeLessThan(slow.stats.cooldown ?? 0);
      const lost = (move: string) => {
        const { sim, p } = orbSim(move);
        steps(sim, seconds(1)); // first cast
        const hp = p.hp;
        steps(sim, seconds(4));
        return hp - p.hp;
      };
      const a = lost(fast.id);
      const b = lost(slow.id);
      const maxHp = player(quietSim()).maxHp;
      expect(a).toBeCloseTo(maxHp * rate * 4, 0);
      expect(Math.abs(a - b)).toBeLessThan(maxHp * rate * 0.2);
    });

    it('a bond (several moves cast together) costs the same as one move', () => {
      const one = orbSim(fast.id);
      const two = orbSim(fast.id);
      const other = shots.find((m) => m.id !== fast.id)!;
      two.p.moves.push(newMove(two.sim.ctx, other.id));
      two.p.slots = [[fast.id, other.id]];
      steps(one.sim, seconds(5));
      steps(two.sim, seconds(5));
      expect(two.p.hp).toBeCloseTo(one.p.hp, 1);
    });

    it('never drains below its configured floor and resumes after healing above it', () => {
      const { sim, p } = orbSim(fast.id);
      p.hp = p.maxHp * (floor + rate);
      steps(sim, seconds(10));
      expect(p.hp).toBeCloseTo(p.maxHp * floor, 5);
      expect(p.dead).toBe(false);
      const healedHp = p.maxHp * (floor + (1 - floor) / 2);
      p.hp = healedHp;
      steps(sim, seconds(2));
      expect(p.hp).toBeLessThan(healedHp);
      expect(p.hp).toBeGreaterThan(p.maxHp * floor);
    });

    it('no drain while idle (nothing to attack) or paused for a choice', () => {
      const sim = quietSim();
      const p = player(sim);
      equip(sim.ctx, p, 'life-orb');
      giveMove(sim, p, 'tackle'); // melee: only casts with a target in reach
      p.regen = 0;
      p.hp = p.maxHp * 0.8;
      steps(sim, seconds(5));
      expect(p.hp).toBeCloseTo(p.maxHp * 0.8, 5);

      const busy = orbSim(fast.id);
      steps(busy.sim, seconds(1));
      openChoice(busy.sim.ctx, {
        kind: 'item',
        playerId: busy.p.id,
        held: 'life-orb',
        found: 'leftovers',
      });
      const hp = busy.p.hp;
      steps(busy.sim, seconds(5));
      expect(busy.sim.paused).toBe(true);
      expect(busy.p.hp).toBe(hp);
    });

    it('no drain while down or disconnected', () => {
      const { sim, p } = orbSim(fast.id);
      steps(sim, seconds(1));
      sim.setConnected(p.id, false);
      const hp = p.hp;
      steps(sim, seconds(3));
      expect(p.hp).toBe(hp);
    });
  });

  it('Rocky Helmet: enemies that touch you get hurt', () => {
    const sim = quietSim(1, { debug: { invulnerable: true } });
    const p = player(sim);
    equip(sim.ctx, p, 'rocky-helmet');
    giveMove(sim, p, 'swords-dance');
    const e = spawnDummy(sim, p.x + 5, p.y, { damage: 5 });
    sim.drainEvents();
    steps(sim, 1);
    expect(damageTo(sim.drainEvents(), e.id)).toBe(
      (d.item('rocky-helmet').params?.damageBase ?? 0) +
        (d.item('rocky-helmet').params?.damagePerLevel ?? 0) * sim.state.team.level,
    );
  });

  it('Assault Vest and Choice Scarf change defense and speed', () => {
    const sim = quietSim();
    const p = player(sim);
    equip(sim.ctx, p, 'assault-vest');
    expect(p.damageReduction).toBeCloseTo(d.item('assault-vest').effects[0]!.value);
    equip(sim.ctx, p, 'choice-scarf');
    expect(p.damageReduction).toBeCloseTo(0);
    expect(p.speedMul).toBeCloseTo(d.item('choice-scarf').effects[0]!.value);
  });
});
