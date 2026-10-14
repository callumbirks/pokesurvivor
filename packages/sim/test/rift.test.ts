// Rifts and the legendary's arena: the schedule (and its guarantee, the legacy "no rifts" bug),
// placement, entering, winning, losing and going back.
import { describe, expect, it } from 'vitest';
import { DT, TILE } from '../src/constants.js';
import { simData } from '../src/data.js';
import { addEnemy, createEnemy, hurtEnemy } from '../src/enemies.js';
import { createSim, type Sim } from '../src/index.js';
import { dropPickup } from '../src/pickups.js';
import { hurtPlayer } from '../src/players.js';
import { placeRift, updateRift } from '../src/rift.js';
import { bossAlive } from '../src/runevents.js';
import { WALL, isFree, terrainAt } from '../src/world.js';
import { botInputs, pickFirst } from './bots.js';
import { giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const d = simData();
const R = d.game.tuning.rift;

/** Puts the clock just before the next roll, past `startAfter`. */
function rollNow(sim: Sim, misses = 0): void {
  sim.state.time = Math.max(sim.state.time, R.startAfter + 1);
  sim.state.rift.misses = misses;
  sim.state.rift.checkT = DT / 2;
}

/** A sim whose players don't attack (so the legendary only dies when the test says). */
function calmSim(n = 1, invulnerable = true): Sim {
  const sim = quietSim(n, { debug: { invulnerable } });
  for (const p of sim.state.players) giveMove(sim, p, 'harden');
  return sim;
}

/** Opens a rift and walks player 0 onto it. */
function enter(sim: Sim, type?: Parameters<Sim['debugStartArena']>[0]): void {
  if (type) {
    sim.debugStartArena(type);
    return;
  }
  sim.debugOpenRift();
  const rift = sim.state.rift.open!;
  const p = player(sim);
  p.x = rift.x;
  p.y = rift.y - 10;
  sim.step();
}

function spawnBoss(sim: Sim, x: number, y: number) {
  const def = { dex: 149, behavior: 'chase' as const, hp: 1e9, speed: 0, damage: 0, xp: 1 };
  return addEnemy(sim.ctx, createEnemy(sim.ctx, def, x, y, { hp: 1, speed: 1, damage: 1 }, true));
}

/** Steps, taking the first option of any choice (the legendary's XP brings level-ups). */
function play(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    pickFirst(sim);
    sim.step();
  }
}

function killLegend(sim: Sim): void {
  const e = sim.state.enemies.find((x) => x.legend)!;
  hurtEnemy(sim.ctx, e, e.hp + e.shield + 1, { by: player(sim).id });
}

describe('rift schedule', () => {
  it('rolls every checkEvery s from startAfter, not before', () => {
    const sim = quietSim();
    let firstRoll = -1;
    while (sim.state.time < R.startAfter + R.checkEvery + 1) {
      sim.step();
      const rf = sim.state.rift;
      if (firstRoll < 0 && (rf.opened || rf.misses)) firstRoll = sim.state.time;
    }
    expect(firstRoll).toBeGreaterThan(R.startAfter + R.checkEvery - 0.1);
    expect(firstRoll).toBeLessThan(R.startAfter + R.checkEvery + 0.1);
  });

  it('each miss raises the chance: after 4 misses the roll is certain', () => {
    expect(R.chance * 5).toBeCloseTo(1);
    for (const seed of [1, 2, 3]) {
      const sim = quietSim(1, { seed });
      rollNow(sim, 4);
      sim.step();
      expect(sim.state.rift.open).not.toBeNull();
      expect(sim.state.rift.misses).toBe(0);
    }
  });

  it('a living boss does not hold the rift back (the legacy bug)', () => {
    const sim = quietSim();
    const p = player(sim);
    spawnBoss(sim, p.x + 200, p.y);
    expect(bossAlive(sim.ctx)).toBe(true);
    rollNow(sim, 4);
    sim.step();
    expect(sim.state.rift.open).not.toBeNull();
  });

  it('an unentered rift expires after ttl and the next roll is checkEvery s later', () => {
    const sim = quietSim();
    sim.state.time = R.startAfter + 1;
    sim.debugOpenRift();
    const events: string[] = [];
    steps(sim, seconds(R.ttl) + 1);
    for (const e of sim.drainEvents()) events.push(e.type);
    expect(events).toContain('rift-closed');
    expect(sim.state.rift.open).toBeNull();
    sim.state.rift.misses = 4;
    steps(sim, seconds(R.checkEvery) - 2);
    expect(sim.state.rift.open).toBeNull();
    steps(sim, 3);
    expect(sim.state.rift.open).not.toBeNull();
  });

  it('opens at the legacy distance on open ground', () => {
    const sim = quietSim();
    const p = player(sim);
    sim.debugOpenRift();
    const { x, y } = sim.state.rift.open!;
    const r = Math.hypot(x - p.x, (y - p.y) / 0.85);
    expect(r).toBeGreaterThanOrEqual(R.distance[0] - 1);
    expect(r).toBeLessThanOrEqual(R.distance[1] + 1);
    expect(isFree(sim.ctx, x, y, 22)).toBe(true);
  });

  it('placement never fails: past both rings, the free tile closest to the ring', () => {
    const sim = quietSim();
    const p = player(sim);
    // Only one tile far outside both rings has room.
    const tx = Math.floor((p.x + R.distance[1] * 1.55) / TILE);
    const ty = Math.floor((p.y + 300) / TILE);
    const only = (x: number, y: number) =>
      Math.floor(x / TILE) === tx && Math.floor(y / TILE) === ty;
    const [x, y] = placeRift(sim.ctx, p, only);
    expect([Math.floor(x / TILE), Math.floor(y / TILE)]).toEqual([tx, ty]);
    // Nowhere at all: the player's own spot.
    expect(placeRift(sim.ctx, p, () => false)).toEqual([p.x, p.y]);
  });

  it('placement in the arena (walled in) still lands on free ground', () => {
    const sim = quietSim();
    sim.debugStartArena('rock');
    const p = player(sim);
    for (let i = 0; i < 20; i++) {
      const [x, y] = placeRift(sim.ctx, p);
      expect(isFree(sim.ctx, x, y, 22)).toBe(true);
    }
  });

  it('long bot run: a rift at most 5 rolls after the last one is over, bosses or not', () => {
    const sim = createSim({
      seed: 31,
      players: [{ id: 'a', dex: 25 }],
      debug: { invulnerable: true, noSpawns: true },
    });
    // The schedule doesn't need combat (so 18 minutes run fast): no spawns and the bots don't
    // attack, but a boss is alive for most of the run, as in a late game. Legacy rolled no rifts
    // while one was.
    for (const p of sim.state.players) giveMove(sim, p, 'harden');
    const maxWait = Math.ceil(1 / R.chance) * R.checkEvery; // 150 s
    // Between two openings: the rift's ttl, an arena (entered at the last moment, fought to
    // the limit) and the wait.
    const maxGap = maxWait + R.ttl + R.arenaTime + R.returnAfterWin;
    let free = R.startAfter; // the schedule runs from here
    const opens: number[] = [];
    let withBoss = 0;
    let arenas = 0;
    let worstWait = 0;
    while (sim.state.time < 18 * 60) {
      pickFirst(sim);
      botInputs(sim);
      // Every other rift, a bot steps into it 20 s after it opens (bots can't find their way
      // there through walls; this test is about the schedule).
      const rift = sim.state.rift.open;
      if (rift && opens.length % 2 === 0 && rift.t > 20) {
        const p = sim.state.players[0]!;
        p.x = rift.x;
        p.y = rift.y - 10;
      }
      const now = sim.state.time;
      if (!sim.state.arena && !bossAlive(sim.ctx) && now % 600 > 120) {
        const p = sim.state.players[0]!;
        spawnBoss(sim, p.x + 250, p.y).speed = 60;
      }
      if (!sim.state.arena && now % 600 < 120)
        sim.state.enemies = sim.state.enemies.filter((e) => !e.boss);
      sim.step();
      for (const e of sim.drainEvents()) {
        const t = sim.state.time;
        if (e.type === 'rift-opened') {
          worstWait = Math.max(worstWait, t - free);
          expect(t - free).toBeLessThanOrEqual(maxWait + 2 * DT);
          if (opens.length) expect(t - opens[opens.length - 1]!).toBeLessThanOrEqual(maxGap);
          opens.push(t);
          if (bossAlive(sim.ctx)) withBoss++;
        }
        if (e.type === 'rift-closed' && e.reason === 'expired') free = t;
        if (e.type === 'arena-left') {
          free = t;
          arenas++;
        }
      }
    }
    // 18 minutes: at least one rift every maxGap.
    expect(opens.length).toBeGreaterThanOrEqual(Math.floor((18 * 60 - R.startAfter) / maxGap));
    expect(arenas).toBeGreaterThanOrEqual(2);
    // Legacy skipped every roll with a boss alive; these would never have opened.
    expect(withBoss).toBeGreaterThan(0);
    expect(worstWait).toBeLessThanOrEqual(maxWait + 2 * DT);
  }, 120_000);
});

describe('the arena', () => {
  describe.each(['won', 'lost'] as const)('%s rift exit', (result) => {
    /** Resolve the fight, then run the return tick without unrelated combat or level-ups. */
    function leave(sim: Sim): void {
      if (result === 'won') killLegend(sim);
      else sim.state.arena!.t = R.arenaTime;
      updateRift(sim.ctx);
      expect(sim.state.arena?.phase).toBe(result);
      sim.state.arena!.endT = 0;
      sim.drainEvents();
      updateRift(sim.ctx);
      expect(sim.state.arena).toBeNull();
    }

    it.each([1, 2])('heals low-HP survivors by 30%% of max HP with %i player(s)', (n) => {
      const sim = calmSim(n);
      sim.debugStartArena('water');
      for (const p of sim.state.players) p.hp = p.maxHp * 0.1;

      leave(sim);

      const events = sim.drainEvents();
      for (const p of sim.state.players) {
        expect(p.dead).toBe(false);
        expect(p.hp).toBeCloseTo(p.maxHp * 0.4);
        expect(events).toContainEqual({
          type: 'player-healed',
          playerId: p.id,
          amount: Math.round(p.maxHp * 0.3),
        });
      }
    });

    it('caps healing at max HP and reports only the amount restored', () => {
      const sim = calmSim();
      sim.debugStartArena('water');
      const p = player(sim);
      p.hp = p.maxHp - 2;

      leave(sim);

      expect(p.hp).toBe(p.maxHp);
      expect(sim.drainEvents()).toContainEqual({
        type: 'player-healed',
        playerId: p.id,
        amount: 2,
      });
    });

    it('revives downed players at 30% without also healing them', () => {
      const sim = calmSim(2, false);
      sim.debugStartArena('water');
      const p = player(sim, 1);
      hurtPlayer(sim.ctx, p, 1e9, null);

      leave(sim);

      expect(p.dead).toBe(false);
      expect(p.hp).toBeCloseTo(p.maxHp * 0.3);
      const events = sim.drainEvents();
      expect(events).toContainEqual({ type: 'player-revived', playerId: p.id, by: null });
      expect(events.some((e) => e.type === 'player-healed' && e.playerId === p.id)).toBe(false);
    });

    it('includes disconnected players still present and skips players who left', () => {
      const sim = calmSim(3);
      sim.debugStartArena('water');
      const disconnected = player(sim, 1);
      const left = player(sim, 2);
      disconnected.connected = false;
      left.left = true;
      for (const p of [disconnected, left]) p.hp = p.maxHp * 0.1;

      leave(sim);

      expect(disconnected.hp).toBeCloseTo(disconnected.maxHp * 0.4);
      expect(left.hp).toBeCloseTo(left.maxHp * 0.1);
    });
  });

  it('touching the rift takes the whole team in; the map waits', () => {
    const sim = quietSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    const dummy = spawnDummy(sim, a.x + 80, a.y);
    enter(sim);
    const s = sim.state;
    const arena = s.arena!;
    expect(arena).not.toBeNull();
    expect(s.rift.open).toBeNull();
    expect(s.world.arena?.tx).toBe(arena.tx);
    // Stashed: only the legendary is around.
    expect(s.enemies.map((e) => e.legend)).toEqual([true]);
    expect(arena.stash.map((e) => e.id)).toContain(dummy.id);
    const legend = s.enemies[0]!;
    expect(legend.boss).toBe(true);
    expect(legend.flying).toBe(false);
    expect(legend.dex).toBe(arena.dex);
    expect(d.game.pokemonByDex.get(legend.dex)?.legendary).toBe(true);
    // Both players are in the arena, south of the centre; the legendary is north.
    for (const p of [a, b]) {
      expect(Math.hypot(p.x - arena.x, p.y - arena.y)).toBeLessThan(arena.r * TILE);
      expect(p.y).toBeGreaterThan(arena.y);
    }
    expect(legend.y).toBeLessThan(arena.y);
    // Walled in.
    expect(terrainAt(sim.ctx, arena.tx + arena.r, arena.ty)).toBe(WALL);
    expect(terrainAt(sim.ctx, arena.tx, arena.ty - arena.r - 1)).toBe(WALL);
  });

  it('nothing spawns and the biome waits while in the arena', () => {
    const sim = createSim({
      seed: 3,
      players: [{ id: 'a', dex: 25 }],
      debug: { invulnerable: true },
    });
    giveMove(sim, player(sim), 'harden');
    sim.state.time = 235;
    sim.debugStartArena('fire');
    steps(sim, seconds(10));
    expect(sim.state.enemies.every((e) => e.legend)).toBe(true);
    expect(sim.state.world.biome).toBe(0);
    killLegend(sim);
    play(sim, seconds(R.returnAfterWin + 1));
    expect(sim.state.arena).toBeNull();
    expect(sim.state.world.biome).toBe(1);
  });

  it("forces the arena's weather and clears it on the way back", () => {
    const sim = calmSim();
    sim.debugStartArena('fire');
    expect(sim.state.weather.current?.kind).toBe('sun');
    killLegend(sim);
    play(sim, seconds(R.returnAfterWin + 1));
    expect(sim.state.weather.current).toBeNull();
  });

  it('winning: rewards, a bond each, progress, then back to where everyone was', () => {
    const sim = calmSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    a.x = 300;
    b.x = -300;
    const dummy = spawnDummy(sim, 500, 0);
    sim.debugStartArena('water');
    const arena = sim.state.arena!;
    const dex = arena.dex;
    sim.drainEvents();
    killLegend(sim);
    steps(sim, 2);
    expect(sim.state.arena?.phase).toBe('won');
    const near = sim.state.pickups.filter((pk) => Math.hypot(pk.x - arena.x, pk.y - arena.y) < 600);
    expect(near.filter((pk) => pk.kind === 'ticket').length).toBeGreaterThanOrEqual(
      R.rewardTickets,
    );
    expect(near.filter((pk) => pk.kind === 'coin' && pk.value === R.rewardCoinValue).length).toBe(
      R.rewardCoinDrops,
    );
    expect(near.every((pk) => pk.pulled)).toBe(true);
    for (const p of [a, b]) {
      expect(p.bonds).toBe(1);
      expect(p.stats.progress.riftWins).toEqual(['water']);
      expect(p.stats.progress.legendariesDefeated).toEqual([dex]);
    }
    const events = sim.drainEvents();
    expect(events.some((e) => e.type === 'progress' && e.event === 'rift-win')).toBe(true);

    play(sim, seconds(R.returnAfterWin));
    expect(sim.state.arena).toBeNull();
    expect(sim.state.world.arena).toBeNull();
    expect(a.x).toBeCloseTo(300);
    expect(b.x).toBeCloseTo(-300);
    expect(sim.state.enemies.map((e) => e.id)).toContain(dummy.id);
    // Back on the map, each spends the bond (the legendary's XP brought new moves to fuse).
    for (const p of [a, b]) {
      const pending = sim.state.pendingChoices.some(
        (c) => c.kind === 'bond' && c.playerId === p.id,
      );
      expect(pending || (p.bonds === 0 && p.slots.some((g) => g.length > 1))).toBe(true);
    }
  });

  it('winning pulls every pickup on the map, inside and far outside the arena', () => {
    const sim = calmSim();
    dropPickup(sim.ctx, 'coin', 1000, 0, 1);
    dropPickup(sim.ctx, 'ticket', -1000, 0, 1);
    sim.debugStartArena('water');
    const arena = sim.state.arena!;
    dropPickup(sim.ctx, 'xp', arena.x, arena.y, 1);
    const pickups = [...sim.state.pickups];
    expect(pickups.every((pk) => !pk.pulled)).toBe(true);
    for (const pk of pickups.slice(0, 2)) {
      expect(Math.hypot(pk.x - arena.x, pk.y - arena.y)).toBeGreaterThan((arena.r + 2) * TILE);
    }

    killLegend(sim);
    steps(sim, 2);

    expect(sim.state.arena?.phase).toBe('won');
    expect(sim.state.pickups.map((pk) => pk.id)).toEqual(
      expect.arrayContaining(pickups.map((pk) => pk.id)),
    );
    expect(sim.state.pickups.every((pk) => pk.pulled)).toBe(true);
  });

  it('the legendary drops a ×10 ticket with legendaryTicket10Chance', () => {
    expect(d.game.tuning.pickups.legendaryTicket10Chance).toBeCloseTo(0.2);
    let x10 = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const sim = quietSim(1, { seed: 1000 + i, debug: { invulnerable: true } });
      sim.debugStartArena();
      killLegend(sim);
      x10 += sim.state.pickups.filter((pk) => pk.kind === 'ticket10').length;
    }
    expect(x10 / n).toBeGreaterThan(0.12);
    expect(x10 / n).toBeLessThan(0.28);
  }, 60_000);

  it('losing on time: back with no reward', () => {
    const sim = calmSim();
    const p = player(sim);
    sim.debugStartArena('ice');
    steps(sim, seconds(R.arenaTime) + 2);
    expect(sim.state.arena?.phase).toBe('lost');
    steps(sim, seconds(R.returnAfterLoss) + 1);
    expect(sim.state.arena).toBeNull();
    expect(p.bonds).toBe(0);
    expect(p.stats.progress.riftWins).toEqual([]);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(100);
  });

  it('losing when everyone is down: the run goes on and the downed are revived', () => {
    const sim = calmSim(2, false);
    sim.debugStartArena('ghost');
    for (const p of sim.state.players) hurtPlayer(sim.ctx, p, 1e9, null);
    expect(sim.state.players.every((p) => p.dead)).toBe(true);
    steps(sim, seconds(1.5));
    expect(sim.state.arena?.phase).toBe('lost');
    steps(sim, seconds(R.returnAfterLoss) + 1);
    expect(sim.ended).toBe(false);
    expect(sim.state.arena).toBeNull();
    for (const p of sim.state.players) {
      expect(p.dead).toBe(false);
      expect(p.hp).toBeCloseTo(p.maxHp * 0.3);
    }
  });

  it('legendaries the players have not beaten come up more often', () => {
    const legends = d.game.pokedex.filter((p) => p.legendary && d.hasSprite(p.dex));
    const beaten = legends.slice(0, Math.floor(legends.length / 2)).map((p) => p.dex);
    let fresh = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const sim = createSim({
        seed: 5000 + i,
        players: [{ id: 'a', dex: 25, legendsBeaten: beaten }],
        debug: { noSpawns: true },
      });
      sim.debugStartArena();
      if (!beaten.includes(sim.state.arena!.dex)) fresh++;
    }
    // Half beaten with weight 1, half fresh with weight 4: ~80% fresh.
    expect(fresh / n).toBeGreaterThan(0.7);
  });
});
