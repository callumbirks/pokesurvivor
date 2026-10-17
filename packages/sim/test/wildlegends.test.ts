// Wild legendaries (`tuning.wildLegends`): when they spawn, how many, their curves, rewards,
// rifts, balance records and saves. Mechanics only: every value comes from the data.
import { describe, expect, it } from 'vitest';
import { DT } from '../src/constants.js';
import { simData } from '../src/data.js';
import { hurtEnemy } from '../src/enemies.js';
import { balanceRecord } from '../src/balance.js';
import { createSim, restoreSim, type Sim } from '../src/index.js';
import { hurtPlayer } from '../src/players.js';
import { bossAlive } from '../src/runevents.js';
import { updateRift } from '../src/rift.js';
import { spawnOne } from '../src/spawner.js';
import { hordeSize, spawnWildLegend, wildLegendsAlive } from '../src/wildlegends.js';
import {
  giveMove,
  patchTuning,
  player,
  postponeAmbientSystems,
  seconds,
  steps,
} from './helpers.js';
import type { EnemyState } from '../src/state.js';

const W = simData().game.tuning.wildLegends;
const FROM = W.fromMinute * 60;
/** A spawn rate that makes a spawn certain on every tick it's allowed. */
const ALWAYS = [{ minute: 0, multiplier: 2 * 60 * 30 }];

/**
 * A run at `time` with the spawner on but the horde, bosses, rifts and events out of the way, and
 * players who don't attack (so nothing dies unless the test says).
 */
function lateSim(time: number, players = 1, seed = 7): Sim {
  const sim = createSim({
    seed,
    players: Array.from({ length: players }, (_, i) => ({ id: `p${i}`, dex: 25 })),
    debug: { invulnerable: true },
  });
  patchTuning(sim, 'spawner', { cap: 0 });
  sim.state.time = time;
  sim.state.spawner.bossIndex = 99;
  sim.state.spawner.surgeT = 1e9;
  postponeAmbientSystems(sim, 1e9);
  for (const p of sim.state.players) giveMove(sim, p, 'harden');
  sim.drainEvents();
  return sim;
}

const legends = (sim: Sim): EnemyState[] => sim.state.enemies.filter((e) => e.wildLegend);

function kill(sim: Sim, e: EnemyState, by = player(sim).id): void {
  hurtEnemy(sim.ctx, e, e.hp + e.shield + 1, { by });
}

describe('spawning', () => {
  it('none before fromMinute, then they appear (with the banner)', () => {
    const sim = lateSim(FROM - 2);
    patchTuning(sim, 'wildLegends', { spawnCurve: ALWAYS });
    steps(sim, seconds(2) - 2);
    expect(legends(sim)).toHaveLength(0);
    steps(sim, 3);
    expect(legends(sim).length).toBeGreaterThan(0);
    const says = sim.drainEvents().filter((e) => e.type === 'say');
    expect(says.map((e) => e.key)).toContain('hud.legendsRoamTheWild');
    expect(says.map((e) => e.key)).toContain('hud.aWildLegendAppeared');
  });

  it('keeps at most maxAlive out at once, and replaces a defeated one', () => {
    const sim = lateSim(FROM + 60);
    patchTuning(sim, 'wildLegends', { spawnCurve: ALWAYS });
    steps(sim, seconds(3));
    expect(wildLegendsAlive(sim.ctx)).toBe(W.maxAlive);
    expect(legends(sim)).toHaveLength(W.maxAlive);
    expect(new Set(legends(sim).map((e) => e.dex)).size).toBe(W.maxAlive);
    kill(sim, legends(sim)[0]!);
    steps(sim, 2);
    expect(wildLegendsAlive(sim.ctx)).toBe(W.maxAlive);
  });

  it('spawns at the curve’s rate on average', () => {
    const sim = lateSim(FROM + 60);
    const rate = 30; // per minute, so a long sample stays cheap
    patchTuning(sim, 'wildLegends', { spawnCurve: [{ minute: 0, multiplier: rate }] });
    let spawned = 0;
    for (let i = 0; i < seconds(120); i++) {
      sim.step();
      for (const e of legends(sim)) {
        kill(sim, e);
        spawned++;
      }
      sim.step();
    }
    // 2 ticks per loop: 240 s of sim time.
    expect(spawned / 4).toBeGreaterThan(rate * 0.8);
    expect(spawned / 4).toBeLessThan(rate * 1.2);
  });

  it('none with maxAlive 0, or in a sim with spawns off', () => {
    const sim = lateSim(FROM + 60);
    patchTuning(sim, 'wildLegends', { spawnCurve: ALWAYS, maxAlive: 0 });
    steps(sim, seconds(1));
    expect(legends(sim)).toHaveLength(0);
    const quiet = lateSim(FROM + 60);
    quiet.state.config.noSpawns = true;
    patchTuning(quiet, 'wildLegends', { spawnCurve: ALWAYS });
    steps(quiet, seconds(1));
    expect(legends(quiet)).toHaveLength(0);
  });

  it('is deterministic', () => {
    const run = () => {
      const sim = lateSim(FROM + 60, 2, 1234);
      patchTuning(sim, 'wildLegends', { spawnCurve: [{ minute: 0, multiplier: 20 }] });
      steps(sim, seconds(20));
      return { hash: sim.hash(), dex: legends(sim).map((e) => e.dex) };
    };
    const a = run();
    expect(a.dex.length).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  });
});

describe('rifts', () => {
  it('none spawn while the team is in a rift; the ones out are stashed and come back', () => {
    const sim = lateSim(FROM + 60);
    const out = spawnWildLegend(sim.ctx)!;
    patchTuning(sim, 'wildLegends', { spawnCurve: ALWAYS });
    sim.debugStartArena('water');
    expect(sim.state.arena!.stash).toContain(out);
    steps(sim, seconds(2));
    expect(legends(sim)).toHaveLength(0);
    expect(sim.state.arena!.stash.filter((e) => e.wildLegend)).toEqual([out]);
    // Lose the fight and go back: it's on the map again.
    sim.state.arena!.t = sim.ctx.d.game.tuning.rift.arenaTime + 1;
    updateRift(sim.ctx);
    sim.state.arena!.endT = 0;
    updateRift(sim.ctx);
    expect(sim.state.arena).toBeNull();
    expect(sim.state.enemies).toContain(out);
  });
});

describe('the legendary', () => {
  /** A wild legendary with `patch` on the tuning, spawned at `minute`. */
  function at(minute: number, patch: Partial<typeof W> = {}, players = 1): EnemyState {
    const sim = lateSim(minute * 60, players);
    patchTuning(sim, 'wildLegends', patch);
    // The same draw for each call: the same legendary and spot.
    return spawnWildLegend(sim.ctx, 150)!;
  }
  const flat = (multiplier: number) => [{ minute: 0, multiplier }];

  it('applies the HP, damage and speed curves, interpolating between points', () => {
    const one = { hpCurve: flat(1), damageCurve: flat(1), speedCurve: flat(1) };
    const base = at(45, one);
    const k = at(45, { hpCurve: flat(3), damageCurve: flat(2), speedCurve: flat(0.5) });
    expect(k.maxHp / base.maxHp).toBeCloseTo(3, 2);
    expect(k.damage / base.damage).toBeCloseTo(2, 6);
    expect(k.speed / base.speed).toBeCloseTo(0.5, 6);
    const ramp = [
      { minute: 30, multiplier: 1 },
      { minute: 60, multiplier: 3 },
    ];
    const mid = at(45, { hpCurve: ramp, damageCurve: ramp, speedCurve: ramp });
    expect(mid.maxHp / base.maxHp).toBeCloseTo(2, 2);
    expect(mid.damage / base.damage).toBeCloseTo(2, 6);
    // Held past the last point.
    const late = at(90, { hpCurve: ramp });
    expect(late.maxHp / at(90, one).maxHp).toBeCloseTo(3, 2);
  });

  it('is tougher than a regular wild Pokémon of the last tier at the same minute', () => {
    for (const minute of [W.fromMinute, 60, 90]) {
      const sim = lateSim(minute * 60);
      sim.state.time = Math.max(sim.state.time, sim.ctx.d.game.enemies.tiers.at(-1)!.from);
      const e = spawnWildLegend(sim.ctx, 150)!;
      const regular = spawnOne(sim.ctx, player(sim), sim.state.time)!;
      expect(e.maxHp).toBeGreaterThan(regular.maxHp);
      expect(e.boss).toBe(true);
      expect(e.legend).toBe(false);
    }
  });

  it('scales HP with the team like the horde', () => {
    const solo = at(45);
    const duo = at(45, {}, 2);
    expect(duo.maxHp / solo.maxHp).toBeCloseTo(1.3, 2);
  });

  it('hits are not capped like a regular wild Pokémon’s, and defence applies', () => {
    const sim = lateSim(FROM + 60);
    sim.state.config.invulnerable = false;
    const e = spawnWildLegend(sim.ctx, 150)!;
    expect(e.regularHit).not.toBe(true);
    const p = player(sim);
    const hit = (defense: number) => {
      p.hp = p.maxHp = 1000;
      p.invuln = 0;
      p.defense = defense;
      hurtPlayer(sim.ctx, p, 900, null, e.regularHit);
      return 1000 - p.hp;
    };
    const fraction = sim.ctx.d.game.tuning.spawner.regularHitCapFraction;
    expect(hit(0)).toBeGreaterThan(1000 * fraction);
    expect(hit(1)).toBeCloseTo(hit(0) / 2, 6);
  });

  it('doesn’t count toward the spawner cap or hold up the waves like a boss', () => {
    const sim = lateSim(FROM + 60);
    spawnWildLegend(sim.ctx);
    expect(sim.state.enemies).toHaveLength(1);
    expect(hordeSize(sim.ctx)).toBe(0);
    expect(bossAlive(sim.ctx)).toBe(false);
  });

  it('drops its own loot: XP gems, a heal, gems and tickets by chance; not a boss for coins', () => {
    const sim = lateSim(FROM + 60);
    patchTuning(sim, 'wildLegends', { gemChance: 1, ticketChance: 1 });
    const e = spawnWildLegend(sim.ctx, 150)!;
    const xp = e.xp;
    sim.state.pickups = [];
    kill(sim, e);
    const kinds = sim.state.pickups.map((pk) => pk.kind);
    expect(kinds.filter((k) => k === 'xp-big')).toHaveLength(W.xpGems);
    expect(
      sim.state.pickups.filter((pk) => pk.kind === 'xp-big').reduce((a, pk) => a + pk.value, 0),
    ).toBeGreaterThanOrEqual(xp);
    expect(kinds.filter((k) => k === 'gem')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'ticket')).toHaveLength(1);
    expect(kinds).not.toContain('item');
    expect(kinds).not.toContain('coin');
    steps(sim, 1);
    expect(sim.state.team.bosses).toBe(0);
    expect(player(sim).stats.progress.bossDefeats).toBe(0);
    expect(player(sim).stats.progress.legendariesDefeated).toEqual([]);
  });
});

describe('balance records', () => {
  it('note each one: when it appeared and was defeated, and who dealt the most', () => {
    const sim = lateSim(FROM + 60, 2);
    const [a, b] = sim.state.players;
    const e = spawnWildLegend(sim.ctx, 150)!;
    hurtEnemy(sim.ctx, e, e.maxHp * 0.3, { by: a!.id });
    sim.state.time += 10;
    hurtEnemy(sim.ctx, e, e.maxHp, { by: b!.id });
    const ra = balanceRecord(sim.ctx, a!)!.wildLegends!;
    const rb = balanceRecord(sim.ctx, b!)!.wildLegends!;
    expect(ra).toHaveLength(1);
    expect(ra[0]).toMatchObject({ dex: 150, maxHp: Math.round(e.maxHp), t: FROM + 60 });
    expect(ra[0]!.defeatedAt).toBe(FROM + 70);
    expect(ra[0]!.dealt).toBe(Math.round(e.maxHp * 0.3));
    expect(ra[0]!.top).toBeUndefined();
    expect(rb[0]!.dealt).toBe(Math.round(e.maxHp * 0.7));
    expect(rb[0]!.top).toBe(true);
  });

  it('a down by one names it', () => {
    const sim = lateSim(FROM + 60);
    sim.state.config.invulnerable = false;
    const e = spawnWildLegend(sim.ctx, 150)!;
    const p = player(sim);
    p.hp = 1;
    p.invuln = 0;
    hurtPlayer(sim.ctx, p, 1e6, null, false, { kind: 'contact', dex: e.dex, tier: 'wildLegend' });
    expect(balanceRecord(sim.ctx, p)!.downs.at(-1)!.by).toEqual({
      kind: 'contact',
      dex: 150,
      tier: 'wildLegend',
    });
  });
});

describe('saves', () => {
  it('restore round-trip with one out, then deterministic', () => {
    const sim = lateSim(FROM + 60);
    patchTuning(sim, 'wildLegends', { spawnCurve: [{ minute: 0, multiplier: 20 }] });
    spawnWildLegend(sim.ctx);
    steps(sim, seconds(1));
    sim.drainEvents();
    const restored = restoreSim(structuredClone(sim.state), sim.ctx.d.game);
    restored.ctx.d = sim.ctx.d;
    expect(restored.hash()).toBe(sim.hash());
    for (let i = 0; i < seconds(5); i++) {
      sim.step();
      restored.step();
      expect(restored.drainEvents()).toEqual(sim.drainEvents());
    }
    expect(restored.hash()).toBe(sim.hash());
  });

  it('back-fills saves from before wild legendaries (no NaN in records or rewards)', () => {
    const sim = lateSim(FROM - DT);
    spawnOne(sim.ctx, player(sim), sim.state.time);
    const old = structuredClone(sim.state);
    // A save from before: enemies without the flag (one stashed in a rift too), records without
    // the list.
    sim.debugStartArena('water');
    const withStash = structuredClone(sim.state);
    for (const s of [old, withStash]) {
      for (const e of [...s.enemies, ...(s.arena?.stash ?? [])])
        Reflect.deleteProperty(e, 'wildLegend');
      for (const p of s.players) Reflect.deleteProperty(p.balance, 'wildLegends');
    }
    for (const s of [old, withStash]) {
      const restored = restoreSim(s);
      for (const e of [...restored.state.enemies, ...(restored.state.arena?.stash ?? [])])
        expect(e.wildLegend).toBe(false);
      const p = player(restored);
      expect(p.balance.wildLegends).toEqual([]);
      steps(restored, seconds(1));
      const rec = balanceRecord(restored.ctx, p)!;
      expect(rec.wildLegends).toEqual([]);
      const run = restored.runSummaryFor(p.id);
      for (const k of ['coins', 'gems', 'kills', 'bosses', 'ticketsX1'] as const)
        expect(Number.isFinite(run[k])).toBe(true);
    }
  });
});
