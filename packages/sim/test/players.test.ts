import { simData } from '../src/data.js';
import { describe, expect, it } from 'vitest';
import { hurtPlayer, REVIVE_SECONDS } from '../src/players.js';
import { teamXpFactor } from '../src/team.js';
import { createSim } from '../src/index.js';
import { player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

describe('players', () => {
  it('start from their Pokémon and permanent upgrades', () => {
    const sim = createSim({
      seed: 1,
      players: [
        { id: 'a', dex: 4 },
        { id: 'b', dex: 4, upgrades: { 'max-hp': 10, attack: 99, speed: 2, 'extra-move': 1 } },
      ],
    });
    const [a, b] = sim.state.players;
    expect(b!.maxHp).toBe(
      a!.maxHp +
        Math.min(10, sim.ctx.d.game.upgradeById.get('max-hp')!.maxLevel) *
          sim.ctx.d.game.upgradeById.get('max-hp')!.perLevel,
    );
    expect(b!.attackMul).toBeCloseTo(
      1 +
        Math.min(99, sim.ctx.d.game.upgradeById.get('attack')!.maxLevel) *
          sim.ctx.d.game.upgradeById.get('attack')!.perLevel,
    );
    expect(b!.speedMul).toBeCloseTo(
      1 +
        Math.min(2, sim.ctx.d.game.upgradeById.get('speed')!.maxLevel) *
          sim.ctx.d.game.upgradeById.get('speed')!.perLevel,
    );
    expect(a!.moves.map((m) => m.id)).toEqual(['ember']); // Charmander's starting move
    expect(b!.moves.length).toBe(
      Math.min(b!.maxSlots, 1 + sim.ctx.d.game.upgradeById.get('extra-move')!.perLevel),
    ); // "Repertoire": a random second attacking move
    expect(b!.active).toBe(0);
  });

  it('move with input, clamped to full speed', () => {
    const sim = quietSim();
    const p = player(sim);
    sim.setInput(p.id, { moveX: 5, moveY: 0 });
    const x = p.x;
    steps(sim, 30);
    expect(p.x - x).toBeCloseTo(p.baseSpeed * p.speedMul, 0);
  });

  it('go down at 0 HP and get revived by a teammate standing next to them', () => {
    const sim = quietSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    hurtPlayer(sim.ctx, a, 9999, null);
    expect(a.dead).toBe(true);
    b.x = a.x + 100;
    steps(sim, seconds(1));
    expect(a.reviveT).toBe(0); // too far
    b.x = a.x + 20;
    steps(sim, seconds(REVIVE_SECONDS) - 5);
    expect(a.dead).toBe(true);
    expect(a.reviveT).toBeGreaterThan(2.5);
    // Walking away loses progress at half speed.
    b.x = a.x + 100;
    steps(sim, seconds(1));
    expect(a.reviveT).toBeGreaterThan(1.8);
    expect(a.reviveT).toBeLessThan(2.5);
    b.x = a.x + 20;
    steps(sim, seconds(1.5));
    expect(a.dead).toBe(false);
    expect(a.hp).toBeCloseTo(a.maxHp * 0.5);
    expect(b.stats.revivesGiven).toBe(1);
  });

  it('a down player does not cast or attract enemies', () => {
    const sim = quietSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    b.x = 300;
    hurtPlayer(sim.ctx, a, 9999, null);
    const e = spawnDummy(sim, a.x + 40, a.y, { speed: 50 });
    const before = Math.hypot(e.x - b.x, e.y - b.y);
    sim.drainEvents();
    steps(sim, seconds(1));
    expect(Math.hypot(e.x - b.x, e.y - b.y)).toBeLessThan(before - 40); // heading for b
    expect(sim.drainEvents().some((ev) => ev.type === 'cast' && ev.playerId === a.id)).toBe(false);
  });

  it('the run ends once everyone has been down for a moment', () => {
    const sim = quietSim(2);
    hurtPlayer(sim.ctx, player(sim, 0), 9999, null);
    steps(sim, seconds(3));
    expect(sim.ended).toBe(false);
    hurtPlayer(sim.ctx, player(sim, 1), 9999, null);
    steps(sim, seconds(1.5));
    expect(sim.ended).toBe(false);
    steps(sim, seconds(0.2));
    expect(sim.state.ended).toMatchObject({ reason: 'all-down' });
    const events = sim.drainEvents();
    expect(events.filter((e) => e.type === 'progress' && e.event === 'run-end').length).toBe(2);
    const t = sim.state.tick;
    steps(sim, 10);
    expect(sim.state.tick).toBe(t); // stepping an ended run does nothing
  });

  it('disconnected players are idle and invulnerable, and keep their place', () => {
    const sim = quietSim(2);
    const a = player(sim, 0);
    sim.setInput(a.id, { moveX: 1, moveY: 0 });
    sim.setConnected(a.id, false);
    const x = a.x;
    spawnDummy(sim, a.x, a.y + 5, { damage: 50 });
    steps(sim, seconds(2));
    expect(a.x).toBe(x);
    expect(a.hp).toBe(a.maxHp);
    sim.setConnected(a.id, true);
    sim.setInput(a.id, { moveX: 1, moveY: 0 });
    steps(sim, 5);
    expect(a.x).toBeGreaterThan(x);
  });

  it('the run ends when everyone has left', () => {
    const sim = quietSim(2);
    sim.removePlayer('p0');
    steps(sim, 5);
    expect(sim.ended).toBe(false);
    sim.removePlayer('p1');
    expect(sim.state.ended).toMatchObject({ reason: 'everyone-left' });
    expect(sim.summary().players.map((p) => p.left)).toEqual([true, true]);
  });

  it('team XP: average of the bonuses, split across the team', () => {
    const solo = quietSim([{ id: 'a', dex: 25, upgrades: { experience: 8 } }]);
    const upgrade = simData().game.upgradeById.get('experience')!;
    const bonus = Math.min(8, upgrade.maxLevel) * upgrade.perLevel;
    expect(teamXpFactor(solo.ctx)).toBeCloseTo(1 + bonus);
    const duo = quietSim([
      { id: 'a', dex: 25, upgrades: { experience: 8 } },
      { id: 'b', dex: 25 },
    ]);
    expect(teamXpFactor(duo.ctx)).toBeCloseTo((1 + bonus / 2) / 1.6);
    duo.setConnected('b', false);
    expect(teamXpFactor(duo.ctx)).toBeCloseTo(1 + bonus);
  });

  it('switch slots on request, cycle with Q/E', () => {
    const sim = quietSim();
    const p = player(sim);
    sim.submitIntent(p.id, { type: 'cycleSlot', dir: 1 }); // only one slot: no-op
    expect(p.active).toBe(0);
    p.moves.push({ ...p.moves[0]!, id: 'tackle' });
    p.slots.push(['tackle']);
    sim.setInput(p.id, { moveX: 0, moveY: 0, slot: 1 });
    steps(sim, 1);
    expect(p.active).toBe(1);
    steps(sim, 5);
    expect(p.active).toBe(1); // a one-shot request
    sim.submitIntent(p.id, { type: 'cycleSlot', dir: 1 });
    expect(p.active).toBe(0);
  });
});
