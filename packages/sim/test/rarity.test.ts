// Stat card rarities and ceilings. Mechanics only: every number comes from levelup.json, none is
// pinned here, and nothing checks how often a rarity comes up.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { restoreSim } from '../src/index.js';
import { applyCard, atCeiling, maybeLevelUp, offerCards } from '../src/levelup.js';
import { rarityTier, rarityWeights, scaledCardEffect } from '../src/rarity.js';
import type { Sim } from '../src/sim.js';
import type { CardOption, PlayerState, SimState } from '../src/state.js';
import { patchLevelUp, player, quietSim } from './helpers.js';

const d = simData();
const cfg = d.game.levelUp;
const { tiers, odds } = cfg.rarity;
const rolled = cfg.statCards.filter((c) => c.rarity !== false);
const capped = cfg.statCards.filter((c) => c.effect.type === 'stat' && c.effect.cap !== undefined);
const top = tiers.at(-1)!;

const statCard = (id: string, rarity?: string): CardOption => ({
  id: `stat:${id}`,
  type: 'stat',
  statId: id,
  ...(rarity ? { rarity } : {}),
});

/** Offers only `ids` as stat cards, with no free move slot. */
const onlyCards = (sim: Sim, p: PlayerState, ids: string[]) => {
  p.maxSlots = p.slots.length;
  patchLevelUp(sim, { statCards: ids.map((id) => d.statCard(id)) });
};

describe('stat card rarities', () => {
  it('scales the bonus by the tier multiplier, not the multiplier itself', () => {
    expect(rolled.length).toBeGreaterThan(0);
    for (const c of rolled)
      for (const tier of tiers) {
        const sim = quietSim();
        const p = player(sim);
        const e = c.effect;
        const before = e.type === 'stat' ? p[e.stat] : p.maxHp;
        applyCard(sim.ctx, p, statCard(c.id, tier.id));
        if (e.type === 'maxHp') expect(p.maxHp - before).toBeCloseTo(e.value * tier.multiplier);
        else if (e.type === 'stat' && e.op === 'mul') {
          let step = 1 + (e.value - 1) * tier.multiplier;
          if (e.cap !== undefined)
            step = e.value < 1 ? Math.max(e.cap, step) : Math.min(e.cap, step);
          expect(p[e.stat] / before).toBeCloseTo(step);
        } else if (e.type === 'stat') {
          const want = Math.min(e.cap ?? Infinity, before + e.value * tier.multiplier);
          expect(p[e.stat]).toBeCloseTo(want);
        }
        // One pick, whatever the rarity (evolutions only need the card taken).
        expect(p.statsTaken[c.id]).toBe(1);
      }
  });

  it('applies a card without a rarity at its base value', () => {
    for (const c of rolled) expect(scaledCardEffect(c.effect, 1)).toEqual(c.effect);
    expect(rarityTier(cfg.rarity, undefined)).toBeUndefined();
  });

  it('interpolates the odds between the configured points and holds the ends', () => {
    expect(rarityWeights(odds, 0)).toEqual(odds[0]!.weights);
    expect(rarityWeights(odds, -1)).toEqual(odds[0]!.weights);
    for (let i = 1; i < odds.length; i++) {
      const a = odds[i - 1]!;
      const b = odds[i]!;
      expect(rarityWeights(odds, b.minute)).toEqual(b.weights);
      const mid = rarityWeights(odds, (a.minute + b.minute) / 2);
      mid.forEach((w, k) => expect(w).toBeCloseTo((a.weights[k]! + b.weights[k]!) / 2));
    }
    expect(rarityWeights(odds, odds.at(-1)!.minute + 60)).toEqual(odds.at(-1)!.weights);
  });

  it('rolls a tier for every stat card that has rarities, and never for the others', () => {
    const sim = quietSim();
    const p = player(sim);
    const seen = new Set<string>();
    for (const minute of [0, odds.at(-1)!.minute / 2, odds.at(-1)!.minute + 5]) {
      sim.state.time = minute * 60;
      for (let i = 0; i < 300; i++)
        for (const o of offerCards(sim.ctx, p)) {
          if (o.type !== 'stat') {
            expect(o.rarity).toBeUndefined();
            continue;
          }
          seen.add(o.statId!);
          if (d.statCard(o.statId!).rarity === false) expect(o.rarity).toBeUndefined();
          else expect(rarityTier(cfg.rarity, o.rarity)).toBeDefined();
        }
    }
    expect(seen.size).toBe(cfg.statCards.length);
  });

  it('never gives Sitrus Berry a rarity', () => {
    expect(d.statCard('heal').rarity).toBe(false);
    const sim = quietSim();
    const p = player(sim);
    onlyCards(sim, p, ['heal']);
    sim.state.time = (odds.at(-1)!.minute + 5) * 60;
    for (let i = 0; i < 100; i++) {
      const heal = offerCards(sim.ctx, p).find((o) => o.statId === 'heal');
      expect(heal).toBeDefined();
      expect(heal!.rarity).toBeUndefined();
    }
  });

  it('draws only tiers with weight: odds on one tier always roll it', () => {
    for (const tier of tiers) {
      const sim = quietSim();
      const p = player(sim);
      const weights = tiers.map((t) => (t === tier ? 1 : 0));
      onlyCards(sim, p, [rolled[0]!.id]);
      patchLevelUp(sim, { rarity: { tiers, odds: [{ minute: 0, weights }] } });
      for (let i = 0; i < 50; i++)
        for (const o of offerCards(sim.ctx, p))
          if (o.type === 'stat') expect(o.rarity).toBe(tier.id);
    }
  });

  it('keeps the rolled rarity through a JSON restore, and the pick applies it', () => {
    const sim = quietSim();
    onlyCards(sim, player(sim), [rolled[0]!.id]);
    sim.state.pendingLevels = 1;
    maybeLevelUp(sim.ctx);
    const choice = sim.state.pendingChoices.find((c) => c.kind === 'level-up');
    expect(choice?.kind === 'level-up' && choice.options.some((o) => o.rarity)).toBe(true);
    const snap = JSON.parse(JSON.stringify(sim.state)) as SimState;
    const b = restoreSim(snap);
    expect(b.hash()).toBe(sim.hash());
    expect(b.state.pendingChoices).toEqual(sim.state.pendingChoices);
  });

  it('restores a save from before rarities (no card multipliers yet)', () => {
    const sim = quietSim();
    const p = player(sim);
    const c = capped.find((c) => c.effect.type === 'stat' && c.effect.op === 'mul')!;
    for (let i = 0; i < 3; i++) applyCard(sim.ctx, p, statCard(c.id));
    const snap = JSON.parse(JSON.stringify(sim.state)) as SimState;
    for (const q of snap.players) delete (q as Partial<PlayerState>).cardMul;
    const b = restoreSim(snap);
    expect(player(b).cardMul[c.id]).toBeCloseTo(p.cardMul[c.id]!);
  });
});

describe('stat card ceilings', () => {
  it('clamps the pick that would pass the ceiling, then stops offering the card', () => {
    expect(capped.length).toBeGreaterThan(0);
    for (const c of capped) {
      const e = c.effect;
      if (e.type !== 'stat' || e.cap === undefined) continue;
      const sim = quietSim();
      const p = player(sim);
      onlyCards(sim, p, [c.id]);
      expect(offerCards(sim.ctx, p).map((o) => o.id)).toContain(`stat:${c.id}`);
      const start = p[e.stat];
      let picks = 0;
      while (!atCeiling(sim.ctx, p, c.id) && picks < 10_000) {
        applyCard(sim.ctx, p, statCard(c.id, top.id));
        picks++;
      }
      expect(picks).toBeLessThan(10_000);
      if (e.op === 'mul') {
        // Exactly at the ceiling, and the stat moved by the card-driven multiplier only.
        expect(p.cardMul[c.id]).toBe(e.cap);
        expect(p[e.stat] / start).toBeCloseTo(e.cap);
      } else if (e.capOf === 'cards') {
        // What the card's picks added is exactly at the ceiling, and so is the stat's growth.
        expect(p.cardAdd[c.id]).toBe(e.cap);
        expect(p[e.stat] - start).toBeCloseTo(e.cap);
      } else expect(p[e.stat]).toBe(e.cap);
      // A pick past the ceiling (an offer opened just before) changes nothing.
      const at = p[e.stat];
      applyCard(sim.ctx, p, statCard(c.id, top.id));
      expect(p[e.stat]).toBeCloseTo(at);
      for (let i = 0; i < 50; i++)
        expect(offerCards(sim.ctx, p).map((o) => o.id)).not.toContain(`stat:${c.id}`);
    }
  });

  it("bounds only the card-driven multiplier: items and upgrades aren't counted", () => {
    const c = capped.find((c) => c.effect.type === 'stat' && c.effect.op === 'mul')!;
    const e = c.effect;
    if (e.type !== 'stat' || e.cap === undefined) throw new Error('no capped multiplier card');
    const sim = quietSim();
    const p = player(sim);
    // Another source has already moved the stat a long way.
    p[e.stat] *= e.cap * e.cap;
    const before = p[e.stat];
    applyCard(sim.ctx, p, statCard(c.id));
    expect(p[e.stat] / before).toBeCloseTo(e.value);
    expect(atCeiling(sim.ctx, p, c.id)).toBe(false);
  });

  it("bounds only what an added card built when it says so: items and upgrades aren't counted", () => {
    const c = capped.find(
      (c) => c.effect.type === 'stat' && c.effect.op === 'add' && c.effect.capOf === 'cards',
    );
    if (!c) return; // No such card in the data right now.
    const e = c.effect;
    if (e.type !== 'stat' || e.cap === undefined) throw new Error('unreachable');
    const sim = quietSim();
    const p = player(sim);
    // Another source has already passed the ceiling on its own.
    p[e.stat] += e.cap * 2;
    const before = p[e.stat];
    applyCard(sim.ctx, p, statCard(c.id));
    expect(p[e.stat] - before).toBeCloseTo(e.value);
    expect(atCeiling(sim.ctx, p, c.id)).toBe(false);
  });
});
