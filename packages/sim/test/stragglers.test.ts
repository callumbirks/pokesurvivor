import { describe, expect, it } from 'vitest';
import { DT, OUTER_RADIUS } from '../src/constants.js';
import { updateEnemies } from '../src/enemies.js';
import { restoreSim } from '../src/index.js';
import { revivePlayer } from '../src/players.js';
import type { EnemyState, SimState } from '../src/state.js';
import { player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

function transferSetup(count = 42, players = 2) {
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
  it('shares a per-survivor budget and brings a stranded horde over 10–20 seconds', () => {
    const { sim, source, survivor, horde } = transferSetup();
    incapacitate(source);
    const arrived = () => horde.filter((e) => distance(e, survivor) < 1200).length;
    steps(sim, 1);
    expect(arrived()).toBe(2);
    let elapsed = 1;
    for (const [second, count] of [
      [1, 4],
      [5, 16],
      [10, 31],
      [20, 42],
    ]) {
      steps(sim, seconds(second!) - elapsed);
      elapsed = seconds(second!);
      expect(arrived()).toBe(count);
    }
    expect(sim.state.enemies.length).toBe(horde.length);
    expect(horde.every((e) => e.transferFromId === null)).toBe(true);
  });

  it.each(['disconnect', 'leave'] as const)('also meters transfers after a %s', (reason) => {
    const { sim, source, survivor, horde } = transferSetup(12);
    if (reason === 'disconnect') sim.setConnected(source.id, false);
    else sim.removePlayer(source.id);
    steps(sim, seconds(1));
    expect(horde.filter((e) => distance(e, survivor) < 1200)).toHaveLength(4);
    expect(horde.filter((e) => e.transferFromId === source.id)).toHaveLength(8);
  });

  it.each(['revive', 'reconnect'] as const)('retargets remaining enemies on %s', (reason) => {
    const { sim, source, horde } = transferSetup(12);
    if (reason === 'revive') incapacitate(source);
    else sim.setConnected(source.id, false);
    steps(sim, seconds(1));
    const waiting = horde.filter((e) => e.transferFromId !== null);
    const positions = waiting.map((e) => [e.x, e.y]);
    expect(waiting).toHaveLength(8);
    if (reason === 'revive') revivePlayer(sim.ctx, source, 0.5, null);
    else sim.setConnected(source.id, true);
    steps(sim, 1);
    expect(waiting.map((e) => [e.x, e.y])).toEqual(positions);
    expect(waiting.every((e) => e.targetId === source.id && e.transferFromId === null)).toBe(true);
  });

  it('waiting enemies keep walking normally and can finish a transfer without teleporting', () => {
    const { sim, source, survivor, horde } = transferSetup(3);
    incapacitate(source);
    const walker = horde[0]!; // Reverse traversal spends the burst on the other two.
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
    expect(survivor.relocationTokens).toBeCloseTo(tokens + 3 * DT);
  });

  it('meters the out-of-view lag rule too, leaving lag timers intact while waiting', () => {
    const { sim, source, survivor, horde } = transferSetup(8);
    incapacitate(source);
    for (const [i, e] of horde.entries()) {
      e.x = survivor.x - 900;
      e.y = survivor.y + i * 30;
      e.lagT = 3;
    }
    survivor.smoothVx = 100;
    updateEnemies(sim.ctx);
    expect(horde.filter((e) => e.transferFromId === null)).toHaveLength(2);
    expect(horde.filter((e) => e.transferFromId === source.id).every((e) => e.lagT > 3)).toBe(true);
  });

  it('each survivor has a separate bucket', () => {
    const { sim, source, horde } = transferSetup(8, 3);
    const other = player(sim, 2);
    for (const e of horde.slice(4)) {
      e.x = other.x - 1800;
      e.targetId = source.id;
    }
    incapacitate(source);
    steps(sim, 1);
    expect(horde.filter((e) => distance(e, player(sim, 1)) < 1200)).toHaveLength(2);
    expect(horde.filter((e) => distance(e, other) < 1200)).toHaveLength(2);
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
    expect(player(sim, 1).relocationTokens).toBe(2);
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
    expect(restored.state.players.every((p) => p.relocationTokens === 2)).toBe(true);
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
