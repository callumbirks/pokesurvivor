// Earned late-game growth: the guaranteed offensive level-up card and Momentum (kill streaks).
// Mechanics only: every number comes from the tuning, none is pinned here.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { applyStatus, hurtEnemy } from '../src/enemies.js';
import { offerCards } from '../src/levelup.js';
import { attackOf } from '../src/players.js';
import type { Sim } from '../src/sim.js';
import {
  damageTo,
  giveMove,
  patchTuning,
  player,
  quietSim,
  seconds,
  spawnDummy,
  steps,
} from './helpers.js';

const d = simData();
const late = d.game.tuning.lateGrowth.offers;
const momentum = d.game.tuning.momentum;
const offensive = new Set(late.statIds.map((id) => `stat:${id}`));
const TRIALS = 200;

const atMinute = (sim: Sim, minute: number) => {
  sim.state.time = minute * 60;
};
const offenseCount = (sim: Sim) =>
  offerCards(sim.ctx, player(sim)).filter((c) => offensive.has(c.id)).length;

describe('guaranteed offensive level-up card', () => {
  it('is in every offer from the configured minute, and not guaranteed before it', () => {
    const sim = quietSim();
    atMinute(sim, late.fromMinute);
    for (let i = 0; i < TRIALS; i++) {
      expect(offenseCount(sim)).toBeGreaterThanOrEqual(late.guaranteedOffenseSlots);
    }
    // Just before, the ordinary weighted offer: some rounds come without one.
    atMinute(sim, late.fromMinute - 1 / 60);
    const without = Array.from({ length: TRIALS }, () => offenseCount(sim)).filter((n) => !n);
    expect(without.length).toBeGreaterThan(0);
  });

  it('offers whichever card is not capped, and nothing extra once all are', () => {
    const sim = quietSim();
    const p = player(sim);
    atMinute(sim, late.fromMinute + 5);
    const [first, ...rest] = late.statIds;
    const cap = (id: string) => {
      p.statsTaken[id] = d.statCard(id).maxPicks ?? Number.MAX_SAFE_INTEGER;
    };
    cap(first!);
    if (rest.length) {
      for (let i = 0; i < TRIALS; i++) {
        const ids = offerCards(sim.ctx, p).map((c) => c.id);
        expect(ids).not.toContain(`stat:${first}`);
        expect(ids.some((id) => offensive.has(id))).toBe(true);
      }
    }
    for (const id of rest) cap(id);
    for (let i = 0; i < TRIALS; i++) {
      const cards = offerCards(sim.ctx, p);
      expect(cards.some((c) => offensive.has(c.id))).toBe(false);
      expect(cards.length).toBe(d.game.levelUp.cardsOffered);
    }
  });

  it('never pushes a ready move evolution out of the offer', () => {
    const sim = quietSim();
    const p = player(sim);
    atMinute(sim, late.fromMinute + 5);
    giveMove(sim, p, 'ember', d.maxMoveLevel('ember'));
    const needs = d.move('ember').evolution!.requires;
    p.statsTaken[needs] = 1;
    for (let i = 0; i < TRIALS; i++) {
      const ids = offerCards(sim.ctx, p).map((c) => c.id);
      expect(ids).toContain('evolution:ember');
      if (d.game.levelUp.cardsOffered > late.guaranteedOffenseSlots) {
        expect(ids.some((id) => offensive.has(id))).toBe(true);
      }
    }
    // Even with no room for both, the evolution keeps its place.
    sim.ctx.d = {
      ...sim.ctx.d,
      game: { ...sim.ctx.d.game, levelUp: { ...d.game.levelUp, cardsOffered: 1 } },
    };
    for (let i = 0; i < 20; i++) {
      expect(offerCards(sim.ctx, p).map((c) => c.id)).toEqual(['evolution:ember']);
    }
  });
});

describe('momentum', () => {
  /** A player with a one-shot move next to a 1-HP enemy, `n` times. */
  const killNext = (sim: Sim, n: number) => {
    const p = player(sim);
    for (let i = 0; i < n; i++) {
      const e = spawnDummy(sim, p.x + 30, p.y, {}, 1);
      p.moves[0]!.t = 0;
      for (let t = 0; t < 10 && !e.dead; t++) steps(sim, 1);
      expect(e.dead).toBe(true);
      steps(sim, 1); // counted on the enemies' next update
    }
  };

  it('adds a stack per credited kill, up to the cap', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'tackle');
    expect(p.momentum).toBe(0);
    killNext(sim, 3);
    expect(p.momentum).toBeCloseTo(3);
    p.momentum = momentum.maxStacks - 1;
    killNext(sim, 2);
    expect(p.momentum).toBe(momentum.maxStacks);
  });

  it('holds through the grace, then decays steadily', () => {
    const sim = quietSim();
    const p = player(sim);
    const start = Math.min(momentum.maxStacks, momentum.decayPerSecond * 2);
    p.momentum = start;
    p.momentumIdle = 0;
    steps(sim, seconds(momentum.graceSeconds) - 1);
    expect(p.momentum).toBe(start);
    steps(sim, seconds(1) + 1);
    expect(p.momentum).toBeCloseTo(start - momentum.decayPerSecond, 0);
    expect(p.momentum).toBeGreaterThan(0);
    steps(sim, seconds(start / momentum.decayPerSecond));
    expect(p.momentum).toBe(0);
  });

  it('multiplies move damage', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'tackle');
    const base = attackOf(sim.ctx, p);
    p.momentum = momentum.maxStacks;
    p.momentumIdle = -1000; // no decay during the hit
    expect(attackOf(sim.ctx, p)).toBeCloseTo(base * (1 + momentum.perStack * momentum.maxStacks));
    const e = spawnDummy(sim, p.x + 30, p.y);
    sim.drainEvents();
    steps(sim, 2);
    const hit = damageTo(sim.drainEvents(), e.id);
    expect(hit).toBe(
      Math.round(
        (d.move('tackle').stats.damage ?? 0) * attackOf(sim.ctx, p) * d.typeMult('normal', e.types),
      ),
    );
  });

  it('credits burn and poison kills to the player who applied them', () => {
    for (const status of ['burn', 'poison'] as const) {
      const sim = quietSim(2);
      const [a, b] = [player(sim, 0), player(sim, 1)];
      patchTuning(sim, 'momentum', { graceSeconds: 1000 });
      const e = spawnDummy(sim, a.x + 400, a.y, {}, 50);
      // b hits it last, but a's status finishes it.
      hurtEnemy(sim.ctx, e, 1, { by: b.id });
      applyStatus(
        e,
        { burn: status === 'burn' ? 1 : 0, poison: status === 'poison' ? 1 : 0, slow: 0, knockback: 0 },
        a.id,
      );
      e.hp = 1;
      steps(sim, seconds(2));
      expect(e.dead).toBe(true);
      expect(a.stats.lastHits).toBe(1);
      expect(a.momentum).toBeCloseTo(1);
      expect(b.momentum).toBe(0);
    }
  });
});
