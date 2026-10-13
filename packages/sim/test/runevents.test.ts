// Mid-run events (hordes, golden hour, the lost Pokémon) and treasure thieves.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { hurtEnemy } from '../src/enemies.js';
import { createSim, type Sim } from '../src/index.js';
import { hordeTypes, spawnThief, startEvent } from '../src/runevents.js';
import { spawnOne } from '../src/spawner.js';
import { botStep } from './bots.js';
import { giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const d = simData();
const T = d.game.tuning.events;

/** A sim with spawns (events need them); `calm`: the players don't attack. */
function liveSim(n = 1, seed = 9, calm = true): Sim {
  const sim = createSim({
    seed,
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, dex: [25, 4, 7, 1][i] ?? 25 })),
    debug: { invulnerable: true },
  });
  if (calm) for (const p of sim.state.players) giveMove(sim, p, 'harden');
  return sim;
}

describe('treasure thieves', () => {
  it('Gholdengo (×10 ticket) with goldThiefChance, else Meowth (coins)', () => {
    expect(T.goldThiefChance).toBeCloseTo(0.125);
    const sim = quietSim();
    let gold = 0;
    const n = 800;
    for (let i = 0; i < n; i++) {
      spawnThief(sim.ctx);
      const e = sim.state.enemies.pop()!;
      expect(e.behavior).toBe('thief');
      if (e.dex === 1000) {
        gold++;
        expect(e.def.loot).toBe('ticket10');
      } else expect(e.dex).toBe(52);
    }
    expect(gold / n).toBeGreaterThan(0.09);
    expect(gold / n).toBeLessThan(0.16);
  });

  it('escapes after thiefLife s; caught, Gholdengo drops a ×10 ticket', () => {
    const sim = quietSim();
    spawnThief(sim.ctx);
    const thief = sim.state.enemies[0]!;
    steps(sim, seconds(T.thiefLife) + 2);
    expect(sim.state.enemies.find((e) => e.id === thief.id)).toBeUndefined();

    const s2 = quietSim();
    s2.state.events.thieves = 0;
    let e = null;
    for (let i = 0; i < 100 && !e; i++) {
      spawnThief(s2.ctx);
      const last = s2.state.enemies[s2.state.enemies.length - 1]!;
      if (last.dex === 1000) e = last;
      else s2.state.enemies.pop();
    }
    hurtEnemy(s2.ctx, e, 1e9);
    expect(s2.state.pickups.some((k) => k.kind === 'ticket10')).toBe(true);
  });

  it('two per run, the first between thiefFirst s (waiting while a boss is alive)', () => {
    // Bots that fight (the thieves wait for bosses to fall).
    const sim = liveSim(4, 2026, false);
    const at: number[] = [];
    while (sim.state.time < 15 * 60) {
      botStep(sim);
      for (const e of sim.drainEvents()) {
        if (e.type === 'thief') {
          at.push(sim.state.time);
          expect(sim.state.enemies.some((x) => x.boss && !x.dead && x.behavior !== 'thief')).toBe(
            false,
          );
        }
      }
    }
    expect(at.length).toBe(2);
    expect(at[0]).toBeGreaterThanOrEqual(T.thiefFirst[0]);
  }, 30_000);
});

describe('events', () => {
  it('golden hour: enemies (and new spawns) are golden with double XP, for duration s', () => {
    const sim = liveSim();
    const e = spawnDummy(sim, 400, 0);
    const xp = e.xp;
    startEvent(sim.ctx, 'gold');
    expect(e.golden).toBe(true);
    expect(e.xp).toBe(xp * 2);
    const fresh = spawnOne(sim.ctx, player(sim), sim.state.time)!;
    expect(fresh.golden).toBe(true);
    steps(sim, seconds(T.duration) + 1);
    expect(sim.state.events.current).toBeNull();
  });

  it('horde: only its type spawns while it lasts, starting with a burst', () => {
    const sim = liveSim(1, 12);
    sim.state.time = 200;
    const types = hordeTypes(sim.ctx, sim.state.time);
    expect(types.length).toBeGreaterThan(0);
    const before = sim.state.enemies.length;
    startEvent(sim.ctx, 'horde');
    const cur = sim.state.events.current!;
    expect(cur.id).toBe('horde');
    expect(types).toContain(cur.type);
    expect(sim.state.enemies.length - before).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) {
      const e = spawnOne(sim.ctx, player(sim), sim.state.time);
      if (e) expect(e.types).toContain(cur.type);
    }
  });

  it('never the same event twice in a row, and none while a boss is alive', () => {
    const sim = liveSim(4, 2026, false);
    const seen: string[] = [];
    while (sim.state.time < 20 * 60) {
      botStep(sim);
      for (const e of sim.drainEvents()) {
        if (e.type === 'run-event' && e.phase === 'start') {
          seen.push(e.id);
          expect(sim.state.enemies.some((x) => x.boss && !x.dead)).toBe(false);
        }
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  }, 60_000);

  it('lost Pokémon: touch it, it follows; at the marker everyone heals and it may join', () => {
    const sim = quietSim(2);
    for (const p of sim.state.players) giveMove(sim, p, 'harden');
    startEvent(sim.ctx, 'lost');
    const L = sim.state.events.lost!;
    expect(L).not.toBeNull();
    L.joins = true;
    const [a, b] = [player(sim, 0), player(sim, 1)];
    a.x = L.x;
    a.y = L.y + L.r + a.r + 4;
    b.hp = b.maxHp * 0.3;
    b.regen = 0;
    sim.step();
    expect(L.phase).toBe('follow');
    expect(L.follow).toBe(a.id);
    // It keeps up with you.
    a.x += 150;
    const gap = Math.hypot(a.x - L.x, a.y - L.y);
    steps(sim, seconds(1));
    expect(Math.hypot(a.x - L.x, a.y - L.y)).toBeLessThan(gap - 50);
    // Home (teleported: walking there is the player's job).
    a.x = L.x = L.tx;
    a.y = L.y = L.ty;
    sim.step();
    expect(sim.state.events.lost).toBeNull();
    expect(sim.state.events.current).toBeNull();
    expect(b.hp).toBeCloseTo(b.maxHp * 0.8, 0);
    expect(sim.state.pickups.filter((k) => k.kind === 'ticket').length).toBe(1);
    for (const p of [a, b]) expect(p.stats.progress.rescued).toEqual([L.dex]);
    // Already owned: 150 coins instead (× the coin multiplier).
    expect(a.coinMul).toBe(1);
    const plain = sim.runSummaryFor(a.id).coins;
    expect(sim.runSummaryFor(a.id, () => true).coins).toBe(plain + T.rescueOwnedCoins);
    expect(sim.summary((id) => id === b.id).players[1]!.rewardParts.rescues).toBe(
      T.rescueOwnedCoins,
    );
    expect(sim.summary((id) => id === b.id).players[0]!.rewardParts.rescues).toBe(0);
  });

  it('lost Pokémon leaves after lostTime s, or when enemies hurt it enough', () => {
    const sim = quietSim();
    startEvent(sim.ctx, 'lost');
    steps(sim, seconds(T.lostTime) + 2);
    expect(sim.state.events.lost).toBeNull();

    const s2 = quietSim();
    startEvent(s2.ctx, 'lost');
    const L = s2.state.events.lost!;
    spawnDummy(s2, L.x, L.y, { damage: 200 });
    s2.drainEvents();
    steps(s2, seconds(3));
    expect(s2.state.events.lost).toBeNull();
    expect(s2.drainEvents().some((e) => e.type === 'lost-pokemon' && e.phase === 'scared')).toBe(
      true,
    );
  });

  it('nothing starts in the arena, and the lost Pokémon waits there', () => {
    const sim = liveSim();
    startEvent(sim.ctx, 'lost');
    const L = { ...sim.state.events.lost! };
    sim.debugStartArena();
    sim.state.events.nextT = 0;
    sim.state.events.thiefT = 0;
    steps(sim, seconds(5));
    expect(sim.state.events.lost?.t).toBe(L.t);
    expect(sim.state.enemies.every((e) => e.legend)).toBe(true);
  });
});
