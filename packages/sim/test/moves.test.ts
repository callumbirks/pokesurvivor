import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { MOVE_KINDS } from '@pokesurvivor/data';
import { applyCard, offerCards } from '../src/levelup.js';
import { evolutionInfo, levelUpMove } from '../src/moves.js';
import { damageTo, giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const d = simData();

describe('move kinds', () => {
  it('every kind used by the data has a test below', () => {
    const used = new Set(d.game.moves.moves.map((m) => m.kind));
    expect([...used].sort()).toEqual([...MOVE_KINDS].sort());
  });

  it('projectile: fires at the target and hits it', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'water-gun');
    const e = spawnDummy(sim, p.x + 150, p.y);
    steps(sim, 2);
    expect(sim.state.projectiles.filter((q) => q.friendly).length).toBe(
      d.move('water-gun').stats.count,
    );
    sim.drainEvents();
    steps(sim, seconds(0.5));
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
  });

  it('projectile: waits for a target in reach', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'water-gun');
    steps(sim, seconds(1));
    expect(sim.state.projectiles.length).toBe(0);
  });

  it('melee: hits in its arc only', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'bite');
    const front = spawnDummy(sim, p.x + 40, p.y);
    const back = spawnDummy(sim, p.x - 40, p.y);
    p.aim = 0;
    sim.drainEvents();
    steps(sim, 1);
    const ev = sim.drainEvents();
    const hitFront = damageTo(ev, front.id) > 0;
    const hitBack = damageTo(ev, back.id) > 0;
    expect(hitFront !== hitBack).toBe(true); // aims at one, not both (arc < 180°)
  });

  it('beam: hits everything along the line', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'psybeam');
    const a = spawnDummy(sim, p.x + 60, p.y);
    const b = spawnDummy(sim, p.x + 150, p.y);
    const off = spawnDummy(sim, p.x + 100, p.y + 120);
    sim.drainEvents();
    steps(sim, 2);
    const ev = sim.drainEvents();
    expect(damageTo(ev, a.id)).toBeGreaterThan(0);
    expect(damageTo(ev, b.id)).toBeGreaterThan(0);
    expect(damageTo(ev, off.id)).toBe(0);
    const cast = ev.find((e) => e.type === 'cast');
    expect(cast && cast.type === 'cast' && cast.length).toBeGreaterThan(0);
  });

  it('nova: shots in every direction', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'hyper-voice');
    p.moves[0]!.t = 0;
    steps(sim, 1);
    const shots = sim.state.projectiles.filter((q) => q.friendly);
    expect(shots.length).toBe(d.move('hyper-voice').stats.count);
    const angles = shots.map((q) => Math.atan2(q.vy, q.vx));
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(5);
  });

  it('aura: damages everything around, with no target needed', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'discharge');
    const a = spawnDummy(sim, p.x + 40, p.y);
    const b = spawnDummy(sim, p.x - 40, p.y + 10);
    const far = spawnDummy(sim, p.x + 200, p.y);
    sim.drainEvents();
    steps(sim, 1);
    const ev = sim.drainEvents();
    expect(damageTo(ev, a.id)).toBeGreaterThan(0);
    expect(damageTo(ev, b.id)).toBeGreaterThan(0);
    expect(damageTo(ev, far.id)).toBe(0);
  });

  it('buff: stacks up to its cap and wears off', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'swords-dance');
    const buff = d.move('swords-dance').stats;
    steps(sim, seconds((buff.cooldown ?? 0) * (buff.stacks ?? 1) + 1));
    expect(p.buffs.attack.n).toBe(d.move('swords-dance').stats.stacks);
    giveMove(sim, p, 'tackle');
    steps(sim, seconds((buff.duration ?? 0) + 1));
    expect(p.buffs.attack.n).toBe(0);
  });

  it('orbit: keeps `count` orbs that re-hit on their own timer', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'fire-spin');
    steps(sim, 1);
    const orbs = () => sim.state.projectiles.filter((q) => q.orb);
    expect(orbs().length).toBe(d.move('fire-spin').stats.count);
    levelUpMove(sim.ctx, p, p.moves[0]!);
    steps(sim, 1);
    expect(orbs().length).toBe(p.moves[0]!.stats.count ?? 0);
    const e = spawnDummy(sim, p.x + (d.move('fire-spin').stats.radius ?? 0), p.y);
    sim.drainEvents();
    steps(sim, seconds(3));
    const hits = sim.drainEvents().filter((ev) => ev.type === 'enemy-hurt' && ev.id === e.id);
    expect(hits.length).toBeGreaterThan(2);
    // Switching away removes them.
    p.moves.push({ ...p.moves[0]!, id: 'tackle', kind: 'melee' });
    p.slots.push(['tackle']);
    sim.setInput(p.id, { moveX: 0, moveY: 0, slot: 1 });
    steps(sim, 1);
    expect(orbs().length).toBe(0);
  });

  it('boomerang: goes out, comes back and vanishes at its owner', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'bonemerang');
    spawnDummy(sim, p.x + 200, p.y);
    steps(sim, 2);
    const q = sim.state.projectiles.find((x) => x.boomerang > 0);
    expect(q).toBeDefined();
    steps(sim, seconds(1.2));
    expect(q!.back).toBe(true);
    steps(sim, seconds(3));
    expect(sim.state.projectiles.some((x) => x.id === q!.id)).toBe(false);
  });

  it('chain: jumps between nearby enemies, 15% less each time', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'thunderbolt');
    const es = [0, 1, 2, 3, 4].map((i) => spawnDummy(sim, p.x + 100 + i * 60, p.y));
    sim.drainEvents();
    steps(sim, 1);
    const ev = sim.drainEvents();
    const hit = es.map((e) => damageTo(ev, e.id));
    expect(hit.filter((h) => h > 0).length).toBe(d.move('thunderbolt').stats.count);
    expect(hit[1]).toBeLessThan(hit[0]!);
  });

  it('chain (Hex): more damage to enemies with a status', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'hex');
    const e = spawnDummy(sim, p.x + 100, p.y);
    sim.drainEvents();
    steps(sim, 1);
    const plain = damageTo(sim.drainEvents(), e.id);
    e.poison = 1;
    e.poisonT = 99;
    e.poisonTick = 99;
    p.moves[0]!.t = 0;
    steps(sim, 1);
    const ev = sim.drainEvents().filter((x) => x.type === 'enemy-hurt' && x.id === e.id);
    expect(ev[0] && ev[0].type === 'enemy-hurt' && ev[0].amount).toBe(
      Math.round(plain * (d.move('hex').stats.hexBonus ?? 1)),
    );
  });

  it('mine: arms, then blows up when an enemy steps on it', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'spikes');
    p.moves[0]!.t = 0;
    steps(sim, 1);
    const mines = sim.state.fields.filter((f) => f.kind === 'mine');
    expect(mines.length).toBe(d.move('spikes').stats.count);
    giveMove(sim, p, 'swords-dance');
    const m = mines[0]!;
    const e = spawnDummy(sim, m.x, m.y);
    sim.drainEvents();
    steps(sim, seconds(0.5));
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
    expect(sim.state.fields.some((f) => f.id === m.id)).toBe(false);
  });

  it('meteor: lands on nearby enemies after a delay', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'meteor-mash');
    const e = spawnDummy(sim, p.x + 150, p.y);
    sim.drainEvents();
    steps(sim, 2);
    expect(sim.state.fields.filter((f) => f.kind === 'meteor').length).toBeGreaterThan(0);
    expect(damageTo(sim.drainEvents(), e.id)).toBe(0);
    steps(sim, seconds(0.7));
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
  });

  it('turret: shoots by itself for its duration', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'will-o-wisp');
    p.moves[0]!.t = 0;
    steps(sim, 1);
    expect(sim.state.fields.filter((f) => f.kind === 'turret').length).toBe(1);
    giveMove(sim, p, 'swords-dance');
    const e = spawnDummy(sim, p.x + 120, p.y);
    sim.drainEvents();
    steps(sim, seconds(2));
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
    steps(sim, seconds(6));
    expect(sim.state.fields.length).toBe(0);
  });

  it('dash: moves you through enemies, hitting them, briefly invulnerable', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'quick-attack');
    const e = spawnDummy(sim, p.x + 80, p.y);
    const x0 = p.x;
    sim.drainEvents();
    steps(sim, 1);
    expect(p.x - x0).toBeGreaterThan(60);
    expect(p.invuln).toBeGreaterThan(0);
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
  });

  it('trail: leaves damaging pools as you walk (not stacked when standing)', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'flame-wheel');
    steps(sim, seconds(1));
    expect(sim.state.fields.filter((f) => f.kind === 'patch').length).toBe(1);
    sim.setInput(p.id, { moveX: 1, moveY: 0 });
    steps(sim, seconds(1));
    expect(sim.state.fields.filter((f) => f.kind === 'patch').length).toBeGreaterThan(2);
    const f = sim.state.fields[0]!;
    sim.setInput(p.id, { moveX: 0, moveY: 0 });
    const e = spawnDummy(sim, f.x, f.y);
    sim.drainEvents();
    steps(sim, seconds(0.6));
    expect(damageTo(sim.drainEvents(), e.id)).toBeGreaterThan(0);
  });

  it('cone: a fan of short shots', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'flamethrower');
    spawnDummy(sim, p.x + 100, p.y);
    steps(sim, 2);
    const shots = sim.state.projectiles.filter((q) => q.friendly);
    expect(shots.length).toBe(d.move('flamethrower').stats.count);
    for (const q of shots)
      expect(q.life).toBeLessThanOrEqual((d.move('flamethrower').stats.lifetime ?? 0) * 2);
  });
});

describe('levelling and evolution', () => {
  it('applies the upgrade ladder of the move kind', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'ember');
    const m = p.moves[0]!;
    const ladder = d.game.moves.upgradeLadders[m.kind];
    const rules = d.game.moves.modifierRules;
    for (const rung of ladder) {
      const before = { ...m.stats };
      expect(levelUpMove(sim.ctx, p, m)).toBe(true);
      for (const [key, value] of Object.entries(rung.mods)) {
        const stat = key as keyof typeof m.stats;
        const previous = before[stat];
        const expected =
          rules.multiplicative.includes(stat) && previous != null
            ? previous * value
            : rules.additive.includes(stat)
              ? (previous ?? 0) + value
              : value;
        expect(m.stats[stat], key).toBeCloseTo(expected);
      }
    }
    expect(m.level).toBe(ladder.length + 1);
    expect(levelUpMove(sim.ctx, p, m)).toBe(false);
  });

  it('evolves at max level once the required stat card was taken', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'ember', d.maxMoveLevel('ember'));
    const m = p.moves[0]!;
    const needs = d.move('ember').evolution!.requires;
    expect(evolutionInfo(sim.ctx, p, m)).toEqual({ needs, ready: false });
    p.statsTaken[needs] = 1;
    expect(evolutionInfo(sim.ctx, p, m)).toEqual({ needs, ready: true });
    const dmg = m.stats.damage ?? 0;
    // The evolution card is always offered once ready.
    for (let i = 0; i < 5; i++) {
      expect(offerCards(sim.ctx, p).map((c) => c.id)).toContain('evolution:ember');
    }
    applyCard(sim.ctx, p, { id: 'evolution:ember', type: 'evolution', moveId: 'ember' });
    expect(m.evolved).toBe(true);
    expect(m.stats.damage).toBeCloseTo(
      dmg * (d.game.moves.evolutionBoosts[m.kind]?.mods.damage ?? 1),
    );
    expect(p.stats.progress.movesEvolved).toEqual(['ember']);
  });
});
