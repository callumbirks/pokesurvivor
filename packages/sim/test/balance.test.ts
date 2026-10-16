// Balance records (R11): sampled every minute of run time, deterministic, carried through a
// save and restore, and exposed through the run summary. No balance numbers are asserted.
import { describe, expect, it } from 'vitest';
import { createSim, restoreSim, type Sim } from '../src/index.js';
import type { SimState } from '../src/state.js';
import { botStep } from './bots.js';

/** Bot play until `seconds` of run time (choices pause it) or the end. */
function runFor(sim: Sim, seconds: number): void {
  while (!sim.ended && sim.state.time < seconds) botStep(sim);
}

const config = {
  seed: 4242,
  players: [
    { id: 'a', dex: 4, upgrades: { attack: 3, armor: 2 }, prestige: 1 },
    { id: 'b', dex: 7 },
  ],
  // Bots don't last long: keep them up so the run reaches the minutes tested.
  debug: { invulnerable: true },
};

const snapshot = (sim: Sim): SimState => JSON.parse(JSON.stringify(sim.state)) as SimState;

describe('balance records', () => {
  it('samples each minute and records the setup, picks and totals', () => {
    const sim = createSim(config);
    runFor(sim, 185);
    const rec = sim.runSummaryFor('a').balance!;
    expect(rec.v).toBe(1);
    expect(rec.setup).toMatchObject({
      dex: 4,
      prestige: 1,
      upgrades: { attack: 3, armor: 2 },
      players: 2,
      from: 0,
    });
    expect(rec.setup.startMoves.length).toBeGreaterThan(0);
    // Minutes 1–3, then the run's last seconds.
    expect(rec.timeline.map((x) => x.t).slice(0, 3)).toEqual([60, 120, 180]);
    expect(rec.timeline).toHaveLength(4);
    expect(rec.timeline[3]!.t).toBeCloseTo(sim.state.time, 2);
    // The stored timeline has only the whole minutes.
    expect(sim.state.players[0]!.balance.timeline).toHaveLength(3);

    for (const x of rec.timeline) {
      // The attack multiplier is its factors' product.
      const product =
        x.atkCard *
        x.atkUpgrade *
        x.atkItem *
        x.atkPrestige *
        x.atkOther *
        x.atkBuff *
        x.atkMomentum;
      expect(x.atk).toBeCloseTo(product, 1);
      expect(x.maxHp).toBeGreaterThan(0);
    }
    expect(rec.timeline[0]!.atkUpgrade).toBeGreaterThan(1);
    expect(rec.timeline[0]!.atkPrestige).toBeGreaterThan(1);

    // Per-minute amounts add up to the totals.
    const p = sim.state.players[0]!;
    const dealt = rec.timeline.reduce((a, x) => a + x.dealt, 0);
    expect(Math.abs(dealt - p.stats.damageDealt)).toBeLessThanOrEqual(rec.timeline.length);
    const taken = rec.timeline.reduce((a, x) => a + x.taken, 0);
    expect(Math.abs(taken - rec.end.damageTaken)).toBeLessThanOrEqual(rec.timeline.length);
    expect(rec.timeline.reduce((a, x) => a + x.downs, 0)).toBe(p.stats.timesDown);

    // A pick per level-up card taken, with the offer's other cards.
    expect(rec.picks.length).toBe(sim.state.team.level - 1);
    for (const k of rec.picks) {
      expect(k.declined.map((x) => x.split('@')[0])).not.toContain(k.card);
      if (k.card.startsWith('stat:') && k.card !== 'stat:heal') expect(k.value).toBeDefined();
    }
    for (const m of rec.moves) {
      if (rec.setup.startMoves.includes(m.id)) expect(m.learnedAt).toBe(0);
      else
        expect(rec.picks.some((k) => k.card === `new:${m.id}` && k.t === m.learnedAt)).toBe(true);
    }
    expect(rec.end).toMatchObject({ reason: null, left: false, level: sim.state.team.level });
  }, 30_000);

  it('is deterministic and survives a save and restore', () => {
    const a = createSim(config);
    runFor(a, 95);
    const b = restoreSim(snapshot(a));
    for (let i = 0; i < 30 * 70; i++) {
      botStep(a);
      botStep(b);
    }
    expect(b.hash()).toBe(a.hash());
    expect(b.runSummaryFor('a').balance).toEqual(a.runSummaryFor('a').balance);
    expect(b.state.players[0]!.balance.timeline.length).toBe(2);

    const c = createSim(config);
    for (let i = 0; i < a.state.tick; i++) botStep(c);
    expect(c.runSummaryFor('b').balance).toEqual(a.runSummaryFor('b').balance);
  }, 30_000);

  it('a game saved before records existed starts one at the restore', () => {
    const a = createSim(config);
    runFor(a, 70);
    const snap = snapshot(a);
    const restoredAt = a.state.time;
    for (const p of snap.players) delete (p as Partial<typeof p>).balance;
    const b = restoreSim(snap);
    runFor(b, 130);
    const rec = b.runSummaryFor('a').balance!;
    expect(rec.setup.from).toBeCloseTo(restoredAt, 3);
    // Minute 1 was before the restore: the first sample is minute 2.
    expect(rec.timeline[0]!.t).toBe(120);
  }, 30_000);

  it('records what downed a player, the damage just before, and the end', () => {
    const sim = createSim({ seed: 9, players: [{ id: 'a', dex: 1 }] });
    while (!sim.ended && sim.state.time < 25 * 60) {
      // Stand still: the run ends sooner.
      for (const c of sim.state.pendingChoices.slice())
        if (c.kind === 'level-up')
          sim.submitIntent('a', { type: 'pickCard', choiceId: c.id, cardId: c.options[0]!.id });
        else if (c.kind === 'item')
          sim.submitIntent('a', { type: 'pickItem', choiceId: c.id, itemId: c.held });
        else
          sim.submitIntent('a', { type: 'pickBond', choiceId: c.id, moves: c.loose.slice(0, 2) });
      sim.step();
    }
    expect(sim.ended).toBe(true);
    const rec = sim.runSummaryFor('a').balance!;
    expect(rec.end.reason).toBe('all-down');
    const last = rec.downs.at(-1)!;
    expect(last.revivedAt).toBeNull();
    expect(last.by?.kind).toBeTruthy();
    expect(last.taken10s).toBeGreaterThan(0);
    expect(rec.end.downs).toBe(rec.downs.length);
  }, 60_000);

  it('keeps a long run compact', () => {
    const sim = createSim(config);
    runFor(sim, 15 * 60);
    const size = JSON.stringify(sim.runSummaryFor('a').balance).length;
    expect(size).toBeLessThan(40_000);
  }, 60_000);
});
