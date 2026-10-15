// Interactables: altars (powers), springs, locked chests and traps.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { propsInRect, type Prop, type PropType } from '../src/world.js';
import type { Sim } from '../src/index.js';
import type { PlayerState } from '../src/state.js';
import { giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const W = simData().game.world;

/** The nearest interactable of a type (and kind) to the origin. */
function find(sim: Sim, type: PropType, kind?: number): Prop {
  for (let r = 1000; r <= 8000; r += 1000) {
    const list = propsInRect(sim.ctx, -r, -r, r, r).filter(
      (p) => p.type === type && (kind === undefined || p.kind === kind),
    );
    list.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    if (list[0]) return list[0];
  }
  throw new Error(`no ${type} found`);
}

/** Puts a player on a spot (and keeps them still and harmless). */
function standAt(sim: Sim, p: PlayerState, x: number, y: number): void {
  p.x = p.prevX = x;
  p.y = p.prevY = y;
  giveMove(sim, p, 'harden');
}

describe('interactables', () => {
  it('altar: a power for altarPowerSeconds, once (for everyone)', () => {
    const sim = quietSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    const altar = find(sim, 'altar', 0); // Fury: damage ×2
    const before = a.attackMul;
    standAt(sim, a, altar.x, altar.y + altar.r + a.r + 4);
    sim.step();
    expect(a.power?.id).toBe(W.altarPowers[0]!.id);
    expect(a.attackMul).toBeCloseTo(before * W.altarPowers[0]!.effect.value);
    expect(sim.state.world.altarsUsed[altar.key]).toBe(1);
    // Used up: the teammate gets nothing.
    standAt(sim, b, altar.x, altar.y + altar.r + b.r + 4);
    steps(sim, 2);
    expect(b.power).toBeNull();
    steps(sim, seconds(W.altarPowerSeconds));
    expect(a.power).toBeNull();
    expect(a.attackMul).toBeCloseTo(before);
  });

  it('spring: heals while you stand in it, drains, then refills on its own', () => {
    const sim = quietSim();
    const p = player(sim);
    const spring = find(sim, 'spring');
    standAt(sim, p, spring.x, spring.y - 8);
    p.regen = 0;
    p.hp = p.maxHp * 0.2;
    steps(sim, seconds(1));
    expect(p.hp).toBeCloseTo(p.maxHp * (0.2 + W.spring.healPerSecond), 0);
    const charge = sim.state.world.springs[spring.key]!;
    expect(charge).toBeCloseTo(1 - W.spring.drainPerSecond, 1);
    // Away from it, it refills.
    p.x += 300;
    steps(sim, seconds(W.spring.refillSeconds));
    expect(sim.state.world.springs[spring.key]).toBeUndefined();
  });

  it('locked chest: stand by it for bigChestOpenSeconds; loot for everyone', () => {
    const sim = quietSim(2);
    const p = player(sim);
    const chest = find(sim, 'big-chest');
    standAt(sim, p, chest.x, chest.y + chest.r + p.r + 6);
    steps(sim, seconds(W.bigChestOpenSeconds / 2));
    expect(sim.state.world.chests[chest.key]).toBeGreaterThan(0);
    // Stepping away lets the progress slip back.
    p.y += 300;
    steps(sim, seconds(0.5));
    const slipped = sim.state.world.chests[chest.key]!;
    expect(slipped).toBeLessThan(W.bigChestOpenSeconds / 2);
    p.y -= 300;
    steps(sim, seconds(W.bigChestOpenSeconds));
    expect(sim.state.world.broken[chest.key]).toBe(1);
    expect(sim.state.pickups.filter((k) => k.kind === 'ticket').length).toBeGreaterThanOrEqual(1);
    for (const pl of sim.state.players) expect(pl.stats.progress.chestsOpened).toBe(1);
  });

  it('explosive trap: hurts the player who steps on it and the enemies around', () => {
    const sim = quietSim();
    const p = player(sim);
    const trap = find(sim, 'trap', 2);
    const e = spawnDummy(sim, trap.x + 30, trap.y - 8, {}, 10000);
    standAt(sim, p, trap.x, trap.y - 8);
    p.regen = 0;
    // Only the trap: no move (a Harden cast would add defence this tick).
    p.moves = [];
    p.slots = [];
    const hp = p.hp;
    sim.drainEvents();
    sim.step();
    expect(sim.state.world.broken[trap.key]).toBe(1);
    const events = sim.drainEvents();
    expect(events.some((ev) => ev.type === 'trap')).toBe(true);
    // The trap's own hit (the dummy beside it may also touch for the minimum 1).
    const trapHit = Math.round(p.maxHp * W.traps[2]!.playerMaxHpDamage);
    expect(events.some((ev) => ev.type === 'player-hurt' && ev.amount === trapHit)).toBe(true);
    expect(hp - p.hp).toBeGreaterThanOrEqual(trapHit - 0.5);
    const t = W.traps[2]!;
    expect(10000 - e.hp).toBe(t.enemyDamage + t.enemyDamagePerLevel * sim.state.team.level);
  });

  it('sticky trap: slows the player; a walking enemy sets traps off too', () => {
    const sim = quietSim();
    const p = player(sim);
    const trap = find(sim, 'trap', 1);
    standAt(sim, p, trap.x, trap.y - 8);
    sim.step();
    expect(p.slowT).toBeGreaterThan(W.traps[1]!.playerSlowSeconds - 0.1);

    const poison = find(sim, 'trap', 0);
    standAt(sim, p, poison.x + 200, poison.y);
    const e = spawnDummy(sim, poison.x, poison.y - 8, {}, 10000);
    steps(sim, 2);
    expect(sim.state.world.broken[poison.key]).toBe(1);
    expect(e.poison).toBeGreaterThan(0);
  });
});
