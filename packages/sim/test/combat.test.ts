import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { attackOf } from '../src/players.js';
import { damageTo, giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const d = simData();
const types = d.game.types;
const { superEffective, notVeryEffective, immune } = types.softened;
const bounded = (value: number) => Math.min(types.max, Math.max(types.min, value));

describe('type chart (softened)', () => {
  it('replaces the games multipliers with the survivor ones', () => {
    expect(d.typeMult('fire', ['grass'])).toBeCloseTo(bounded(superEffective));
    expect(d.typeMult('fire', ['water'])).toBeCloseTo(bounded(notVeryEffective));
    expect(d.typeMult('normal', ['ghost'])).toBeCloseTo(bounded(immune));
    expect(d.typeMult('electric', ['ground'])).toBeCloseTo(bounded(immune));
    expect(d.typeMult('fire', ['normal'])).toBe(bounded(1));
  });

  it('multiplies across dual types and clamps to the configured bounds', () => {
    expect(d.typeMult('ice', ['grass', 'flying'])).toBeCloseTo(
      Math.min(types.max, superEffective ** 2),
    );
    expect(d.typeMult('water', ['ground', 'grass'])).toBeCloseTo(
      Math.min(types.max, Math.max(types.min, superEffective * notVeryEffective)),
    );
    expect(d.typeMult('normal', ['rock', 'ghost'])).toBeCloseTo(
      Math.max(types.min, notVeryEffective * immune),
    );
    expect(d.typeMult(null, ['ghost'])).toBe(1);
  });
});

describe('damage', () => {
  it('scales move damage by attack and the type chart', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'tackle');
    const e = spawnDummy(sim, p.x + 30, p.y);
    sim.drainEvents();
    steps(sim, 2);
    const hit = damageTo(sim.drainEvents(), e.id);
    const base = (d.move('tackle').stats.damage ?? 0) * attackOf(p);
    expect(hit).toBe(Math.max(1, Math.round(base * d.typeMult('normal', e.types))));
    // A second defender uses its configured type multiplier.
    const ghost = spawnDummy(sim, p.x + 30, p.y + 5, { dex: 92 });
    e.dead = true;
    sim.drainEvents();
    p.moves[0]!.t = 0;
    steps(sim, 1);
    const events = sim.drainEvents();
    const first = events.find((ev) => ev.type === 'enemy-hurt' && ev.id === ghost.id);
    expect(first && first.type === 'enemy-hurt' && first.amount).toBe(
      Math.max(1, Math.round(base * d.typeMult('normal', ghost.types))),
    );
    const multiplier = d.typeMult('normal', ghost.types);
    // Hit-cue thresholds are UI rules; the multiplier is read from the game data.
    expect(first && first.type === 'enemy-hurt' && first.label).toBe(
      multiplier > 1.05 ? 'super' : multiplier < 0.95 ? 'weak' : null,
    );
  });

  it('crits with the configured damage multiplier', () => {
    const sim = quietSim([{ id: 'a', dex: 25, upgrades: { crit: 10 } }]);
    const p = player(sim);
    p.critChance = 1;
    giveMove(sim, p, 'tackle');
    const e = spawnDummy(sim, p.x + 30, p.y);
    sim.drainEvents();
    steps(sim, 2);
    const hurt = sim.drainEvents().find((ev) => ev.type === 'enemy-hurt' && ev.id === e.id);
    const base = (d.move('tackle').stats.damage ?? 0) * attackOf(p);
    expect(hurt && hurt.type === 'enemy-hurt' && hurt.amount).toBe(
      Math.max(
        1,
        Math.round(base * d.game.tuning.combat.critMultiplier * d.typeMult('normal', e.types)),
      ),
    );
    expect(hurt && hurt.type === 'enemy-hurt' && hurt.label).toBe('crit');
  });

  it("tags each hit with the attack's type (moves, burn and poison ticks)", () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'ember');
    const e = spawnDummy(sim, p.x + 60, p.y, {}, 100000);
    steps(sim, seconds(0.5));
    const hurts = () =>
      sim
        .drainEvents()
        .filter((ev) => ev.type === 'enemy-hurt' && ev.id === e.id)
        .map((ev) => (ev.type === 'enemy-hurt' ? ev.moveType : undefined));
    expect(hurts()).toContain('fire');
    // Poison ticks on its own, with its own type.
    e.poison = 1;
    e.poisonT = 5;
    e.poisonTick = 0;
    steps(sim, 2);
    expect(hurts()).toContain('poison');
  });

  it('applies burn, poison and slow, which tick on their own', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'ember');
    const e = spawnDummy(sim, p.x + 60, p.y);
    steps(sim, seconds(0.5));
    expect(e.burn).toBeGreaterThan(0);
    giveMove(sim, p, 'sludge');
    steps(sim, seconds(0.8));
    expect(e.poison).toBeGreaterThan(0);
    giveMove(sim, p, 'ice-beam');
    steps(sim, seconds(1.2));
    expect(e.slow).toBeCloseTo(d.move('ice-beam').stats.slow ?? 0);
    // Statuses keep hurting with no move hitting.
    giveMove(sim, p, 'swords-dance');
    sim.drainEvents();
    steps(sim, seconds(1));
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
  });

  it('knocks enemies back (bosses excepted)', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'body-slam');
    const e = spawnDummy(sim, p.x + 30, p.y);
    steps(sim, 2);
    expect(e.kx).toBeGreaterThan(0);
    // (Out of contact range: touching pushes bosses too.)
    const boss = spawnDummy(sim, p.x + 50, p.y);
    boss.boss = true;
    e.dead = true;
    steps(sim, seconds(1.2));
    expect(boss.kx).toBe(0);
  });

  it('shields absorb damage first', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'tackle');
    const e = spawnDummy(sim, p.x + 30, p.y);
    e.shield = 1000;
    e.shieldT = 8;
    const hp = e.hp;
    steps(sim, 2);
    expect(e.hp).toBe(hp);
    expect(e.shield).toBeLessThan(1000);
  });
});

describe('enemy contact', () => {
  it('hurts the player, with invulnerability frames and a per-enemy cooldown', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'swords-dance');
    spawnDummy(sim, p.x + 5, p.y, { damage: 10 });
    sim.drainEvents();
    steps(sim, seconds(1));
    const hits = sim.drainEvents().filter((ev) => ev.type === 'player-hurt');
    expect(hits.length).toBe(2); // every 0.55 s
    expect(p.hp).toBeLessThan(p.maxHp);
  });

  it('takes less damage with a melee move active', () => {
    const run = (move: string) => {
      const sim = quietSim();
      const p = player(sim);
      giveMove(sim, p, move);
      p.x = 0;
      spawnDummy(sim, 5, 0, { damage: 40 }, 1e9);
      sim.drainEvents();
      steps(sim, 1);
      const ev = sim.drainEvents().find((e) => e.type === 'player-hurt');
      return ev && ev.type === 'player-hurt' ? ev.amount : 0;
    };
    const plain = run('swords-dance');
    const melee = run('tackle');
    expect(melee).toBeGreaterThan(0);
    expect(melee).toBeLessThan(plain);
  });
});
