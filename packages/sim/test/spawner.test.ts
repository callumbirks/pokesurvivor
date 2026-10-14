import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { bossScale, enemyScale, scaleHp, scaleRate, spawnRate, spawnOne } from '../src/spawner.js';
import { createSim, OUTER_RADIUS, type Sim } from '../src/index.js';
import { patchTuning, postponeAmbientSystems, seconds } from './helpers.js';

const d = simData();
const sim1 = () =>
  createSim({ seed: 3, players: [{ id: 'a', dex: 25 }], debug: { invulnerable: true } });

describe('spawn curves', () => {
  it('spawn rate grows with time and scales with the configured density', () => {
    const plain = sim1();
    const denser = sim1();
    patchTuning(denser, 'spawner', { density: d.game.tuning.spawner.density * 2 });
    for (const time of [0, 60, 600])
      expect(spawnRate(denser.ctx, time)).toBeCloseTo(spawnRate(plain.ctx, time) * 2);
    expect(spawnRate(plain.ctx, 60)).toBeGreaterThan(spawnRate(plain.ctx, 0));
    expect(spawnRate(plain.ctx, 600)).toBeGreaterThan(spawnRate(plain.ctx, 60));
  });

  it('enemy and boss scaling, with the configured late-game multiplier', () => {
    const ctx = sim1().ctx;
    const early = enemyScale(ctx, 0);
    const later = enemyScale(ctx, 950);
    expect(later.hp).toBeGreaterThan(early.hp);
    expect(later.damage).toBeGreaterThan(early.damage);
    expect(later.speed).toBeGreaterThanOrEqual(early.speed);
    expect(bossScale(ctx, 600).hp).toBeGreaterThan(bossScale(ctx, 0).hp);
    const late = d.game.enemies.lateGame;
    expect(d.late(late.fromMinute * 60)).toBe(1);
    expect(d.late(90 * 60)).toBeCloseTo(Math.exp(late.k * Math.max(0, 90 - late.fromMinute) ** 2));
    expect(d.late(10_000 * 60)).toBeCloseTo(Math.exp(30)); // capped
  });

  it('co-op: more and tougher enemies per extra player', () => {
    for (const players of [2, 3, 4]) {
      expect(scaleRate(players)).toBeGreaterThan(scaleRate(players - 1));
      expect(scaleHp(players)).toBeGreaterThan(scaleHp(players - 1));
    }
  });
});

describe('roster', () => {
  it('rolls a cast per tier with one support and a runner, and bosses per slot', () => {
    const { roster } = sim1().state;
    expect(roster.tiers.length).toBe(d.game.enemies.tiers.length);
    for (const [i, tier] of roster.tiers.entries()) {
      expect(tier.list.length).toBe(d.game.enemies.tiers[i]!.castSize);
      expect(
        tier.list.filter((e) => ['healer', 'shielder', 'summoner'].includes(e.behavior)).length,
      ).toBeGreaterThanOrEqual(1);
      expect(tier.list.filter((e) => e.behavior === 'runner').length).toBe(1);
      const bst = d.game.enemies.tiers[i]!.bst;
      for (const e of tier.list) {
        const p = d.game.pokemonByDex.get(e.dex)!;
        expect(p.bst).toBeGreaterThanOrEqual(bst[0]);
        expect(p.bst).toBeLessThanOrEqual(bst[1]);
        expect(p.rarity).toBeLessThan(5);
      }
    }
    expect(roster.bosses.map((b) => b.at)).toEqual(d.game.enemies.bossSlots.map((s) => s.at));
    for (const b of roster.bosses) expect(d.game.pokemonByDex.get(b.dex)!.legendary).toBe(false);
    expect(new Set(roster.bosses.map((b) => b.dex)).size).toBe(roster.bosses.length);
  });

  it('the first tier has no warning attackers', () => {
    for (let seed = 1; seed < 20; seed++) {
      const { roster } = createSim({ seed, players: [{ id: 'a', dex: 25 }] }).state;
      for (const e of roster.tiers[0]!.list) {
        expect(['beamer', 'zoner', 'fan', 'jumper', 'bomber']).not.toContain(e.behavior);
      }
    }
  });
});

const run = (sim: Sim, s: number) => {
  for (let i = 0; i < seconds(s); i++) {
    for (const c of sim.state.pendingChoices.slice()) {
      if (c.kind === 'level-up')
        sim.submitIntent(c.playerId, {
          type: 'pickCard',
          choiceId: c.id,
          cardId: c.options[0]!.id,
        });
      else if (c.kind === 'item')
        sim.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.held });
    }
    sim.step();
  }
};

describe('spawning', () => {
  it('spawns outside the view and stays under the cap', () => {
    const sim = sim1();
    const p = sim.state.players[0]!;
    patchTuning(sim, 'spawner', { density: 1 }); // Ensure the placement fixture actually spawns.
    postponeAmbientSystems(sim, 120);
    p.moves = [];
    p.slots = [];
    const seen: number[] = [];
    for (let i = 0; i < seconds(120); i++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.type !== 'enemy-spawned') continue;
        const en = sim.state.enemies.find((x) => x.id === e.id)!;
        // (Summoned minions appear next to their summoner.)
        if (!sim.state.roster.tiers.some((t) => t.list.includes(en.def))) continue;
        seen.push(Math.hypot(en.x - p.x, (en.y - p.y) / 0.9));
      }
      expect(sim.state.enemies.length).toBeLessThanOrEqual(d.game.tuning.spawner.cap + 15);
      for (const c of sim.state.pendingChoices.slice()) {
        if (c.kind === 'level-up')
          sim.submitIntent(c.playerId, {
            type: 'pickCard',
            choiceId: c.id,
            cardId: c.options[0]!.id,
          });
      }
      p.moves = [];
      p.slots = [];
      p.active = 0;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThan(OUTER_RADIUS - 1);
  }, 30_000);

  it('spawns the first boss at its configured time, scaled for the team size', () => {
    const solo = sim1();
    const at = solo.state.roster.bosses[0]!.at;
    run(solo, at - 1);
    expect(solo.state.enemies.some((e) => e.boss)).toBe(false);
    run(solo, 2);
    const boss = solo.state.enemies.find((e) => e.boss)!;
    expect(boss).toBeDefined();
    expect(boss.dex).toBe(solo.state.roster.bosses[0]!.dex);
    const def = solo.state.roster.bosses[0]!;
    expect(boss.maxHp).toBe(
      Math.round(def.hp * bossScale(solo.ctx, boss.sc.hp > 0 ? at + 1 / 30 : 0).hp),
    );

    const duo = createSim({
      seed: 3,
      players: [
        { id: 'a', dex: 25 },
        { id: 'b', dex: 25 },
      ],
      debug: { invulnerable: true },
    });
    run(duo, at + 1);
    const boss2 = duo.state.enemies.find((e) => e.boss)!;
    expect(boss2.sc.hp / boss.sc.hp).toBeGreaterThan(1);
  }, 30_000);

  it('enemies past the cap threshold spawn as elites', () => {
    const plain = sim1();
    const crowded = sim1();
    // A small cap keeps the threshold fixture fast for any shipped cap.
    for (const sim of [plain, crowded]) patchTuning(sim, 'spawner', { cap: 4 });
    const baseline = spawnOne(plain.ctx, plain.state.players[0]!, 0)!;
    const tuning = crowded.ctx.d.game.tuning.spawner;
    const count = Math.ceil(tuning.cap * tuning.eliteFrom);
    crowded.state.enemies = Array.from({ length: count }, (_, i) => ({ ...baseline, id: i + 1 }));
    crowded.state.nextId = count + 1;
    const elite = spawnOne(crowded.ctx, crowded.state.players[0]!, 0)!;
    expect(elite.dex).toBe(baseline.dex);
    expect(elite.maxHp).toBeGreaterThanOrEqual(baseline.maxHp);
    expect(elite.damage).toBeGreaterThanOrEqual(baseline.damage);
    expect(elite.maxHp > baseline.maxHp || elite.damage > baseline.damage).toBe(true);
  });
});
