import { describe, expect, it } from 'vitest';
import { DT, OUTER_RADIUS } from '../src/constants.js';
import { simData } from '../src/data.js';
import { updateEnemies } from '../src/enemies.js';
import { restoreSim } from '../src/index.js';
import { revivePlayer } from '../src/players.js';
import type { EnemyState, SimState } from '../src/state.js';
import { player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const tuning = simData().game.tuning.stragglers;
const budget = (ticks: number) =>
  Math.floor(tuning.burst + tuning.relocationsPerSecond * DT * (ticks - 1) + 1e-9);
const strandedCount = budget(seconds(1)) + 8;

function transferSetup(count = strandedCount, players = 2) {
  const sim = quietSim(players, { debug: { invulnerable: true } });
  for (const [i, p] of sim.state.players.entries()) {
    p.x = i === 0 ? -4000 : (i - 1) * 4000;
    p.moves = [];
  }
  const source = player(sim);
  const horde = Array.from({ length: count }, (_, i) => {
    const e = spawnDummy(sim, source.x + (i % 7) * 40, source.y + Math.floor(i / 7) * 40);
    e.flying = true;
    return e;
  });
  return { sim, source, survivor: player(sim, 1), horde };
}

const distance = (e: EnemyState, p: { x: number; y: number }) => Math.hypot(e.x - p.x, e.y - p.y);

const incapacitate = (source: ReturnType<typeof player>) => {
  source.dead = true;
  source.hp = 0;
};

describe('straggler transfers', () => {
  it('limits arrivals by the configured rate plus burst and eventually transfers the horde', () => {
    const hordeSize = Math.ceil(tuning.burst + tuning.relocationsPerSecond * 15);
    const { sim, source, survivor, horde } = transferSetup(hordeSize);
    incapacitate(source);
    const arrived = () => horde.filter((e) => distance(e, survivor) < 1200).length;
    const ticks = Math.ceil(horde.length / (tuning.relocationsPerSecond * DT)) + 2;
    let previous = 0;
    for (let elapsed = 1; elapsed <= ticks; elapsed++) {
      steps(sim, 1);
      const count = arrived();
      expect(count).toBeGreaterThanOrEqual(previous);
      expect(count).toBeLessThanOrEqual(Math.min(horde.length, budget(elapsed)));
      previous = count;
    }
    expect(arrived()).toBe(horde.length);
    expect(sim.state.enemies.length).toBe(horde.length);
    expect(horde.every((e) => e.transferFromId === null)).toBe(true);
  });

  it.each(['disconnect', 'leave'] as const)('also meters transfers after a %s', (reason) => {
    const { sim, source, survivor, horde } = transferSetup(strandedCount);
    if (reason === 'disconnect') sim.setConnected(source.id, false);
    else sim.removePlayer(source.id);
    steps(sim, seconds(1));
    expect(horde.filter((e) => distance(e, survivor) < 1200)).toHaveLength(budget(seconds(1)));
    expect(horde.filter((e) => e.transferFromId === source.id)).toHaveLength(
      horde.length - budget(seconds(1)),
    );
  });

  it.each(['revive', 'reconnect'] as const)('retargets remaining enemies on %s', (reason) => {
    const { sim, source, horde } = transferSetup(strandedCount);
    if (reason === 'revive') incapacitate(source);
    else sim.setConnected(source.id, false);
    steps(sim, seconds(1));
    const waiting = horde.filter((e) => e.transferFromId !== null);
    const positions = waiting.map((e) => [e.x, e.y]);
    expect(waiting).toHaveLength(horde.length - budget(seconds(1)));
    if (reason === 'revive') revivePlayer(sim.ctx, source, 0.5, null);
    else sim.setConnected(source.id, true);
    steps(sim, 1);
    expect(waiting.map((e) => [e.x, e.y])).toEqual(positions);
    expect(waiting.every((e) => e.targetId === source.id && e.transferFromId === null)).toBe(true);
  });

  it('waiting enemies keep walking normally and can finish a transfer without teleporting', () => {
    const { sim, source, survivor, horde } = transferSetup(Math.ceil(tuning.burst) + 1);
    incapacitate(source);
    const walker = horde[0]!; // Reverse traversal spends the burst on the other enemies.
    walker.speed = 60;
    const before = distance(walker, survivor);
    steps(sim, 1);
    expect(distance(walker, survivor)).toBeCloseTo(before - walker.speed * DT);
    expect(walker.transferFromId).toBe(source.id);
    walker.x = survivor.x + OUTER_RADIUS;
    walker.y = survivor.y;
    const tokens = survivor.relocationTokens;
    steps(sim, 1);
    expect(walker.transferFromId).toBeNull();
    expect(survivor.relocationTokens).toBeCloseTo(
      Math.min(tuning.burst, tokens + tuning.relocationsPerSecond * DT),
    );
  });

  it('meters the out-of-view lag rule too, leaving lag timers intact while waiting', () => {
    const { sim, source, survivor, horde } = transferSetup(Math.ceil(tuning.burst) + 6);
    incapacitate(source);
    for (const [i, e] of horde.entries()) {
      e.x = survivor.x - 900;
      e.y = survivor.y + i * 30;
      e.lagT = 3;
    }
    survivor.smoothVx = 100;
    updateEnemies(sim.ctx);
    expect(horde.filter((e) => e.transferFromId === null)).toHaveLength(Math.floor(tuning.burst));
    expect(horde.filter((e) => e.transferFromId === source.id).every((e) => e.lagT > 3)).toBe(true);
  });

  it('each survivor has a separate bucket', () => {
    const { sim, source, horde } = transferSetup((Math.ceil(tuning.burst) + 2) * 2, 3);
    const other = player(sim, 2);
    for (const e of horde.slice(horde.length / 2)) {
      e.x = other.x - 1800;
      e.targetId = source.id;
    }
    incapacitate(source);
    steps(sim, 1);
    expect(horde.filter((e) => distance(e, player(sim, 1)) < 1200)).toHaveLength(
      Math.floor(tuning.burst),
    );
    expect(horde.filter((e) => distance(e, other) < 1200)).toHaveLength(Math.floor(tuning.burst));
  });

  it('keeps bosses, shinies and legends exempt from relocation', () => {
    const { sim, source, horde } = transferSetup(3);
    horde[0]!.boss = true;
    horde[1]!.shiny = true;
    horde[2]!.legend = true;
    const positions = horde.map((e) => [e.x, e.y]);
    incapacitate(source);
    steps(sim, seconds(2));
    expect(horde.map((e) => [e.x, e.y])).toEqual(positions);
    expect(player(sim, 1).relocationTokens).toBe(tuning.burst);
  });

  it('restores an in-progress transfer exactly and continues with identical states and events', () => {
    const { sim, source } = transferSetup();
    incapacitate(source);
    steps(sim, 47);
    sim.drainEvents();
    const snap = JSON.parse(JSON.stringify(sim.state)) as SimState;
    const restored = restoreSim(snap);
    expect(restored.hash()).toBe(sim.hash());
    for (let i = 0; i < seconds(20); i++) {
      sim.step();
      restored.step();
      expect(restored.drainEvents()).toEqual(sim.drainEvents());
    }
    expect(restored.hash()).toBe(sim.hash());
  });

  it('migrates older saves and arena stashes without transfer fields', () => {
    const { sim, horde } = transferSetup(1);
    sim.debugStartArena('fire');
    const old = structuredClone(sim.state);
    for (const p of old.players) Reflect.deleteProperty(p, 'relocationTokens');
    for (const e of [...old.enemies, ...old.arena!.stash]) {
      Reflect.deleteProperty(e, 'targetId');
      Reflect.deleteProperty(e, 'transferFromId');
    }
    const restored = restoreSim(old);
    expect(restored.state.players.every((p) => p.relocationTokens === tuning.burst)).toBe(true);
    expect(restored.state.arena!.stash.find((e) => e.id === horde[0]!.id)).toMatchObject({
      targetId: null,
      transferFromId: null,
    });
    expect(
      restored.state.enemies.every((e) => e.targetId === null && e.transferFromId === null),
    ).toBe(true);
  });

  it.each([1, 2])('ordinary catch-up remains unrestricted with %i players', (players) => {
    const sim = quietSim(players);
    const p = player(sim);
    for (const pl of sim.state.players) pl.relocationTokens = 0;
    const horde = Array.from({ length: 12 }, (_, i) => {
      const e = spawnDummy(sim, p.x - 1800, p.y + i * 35);
      e.flying = true;
      return e;
    });
    p.smoothVx = 100;
    updateEnemies(sim.ctx);
    expect(horde.every((e) => distance(e, p) < 1200 && e.transferFromId === null)).toBe(true);
    expect(sim.state.enemies.length).toBe(12);
    const lagger = spawnDummy(sim, p.x - 900, p.y);
    lagger.flying = true;
    lagger.lagT = 2.5;
    updateEnemies(sim.ctx);
    expect(lagger.x).toBeGreaterThan(p.x);
    expect(lagger.lagT).toBe(0);
  });
});
