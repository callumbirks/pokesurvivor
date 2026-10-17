// In-run Mega Evolution: the Unique level-up card (mega.ts), its boost, form and pause.
import { describe, expect, it } from 'vitest';
import { balanceRecord } from '../src/balance.js';
import { resolveChoice } from '../src/choices.js';
import { offerCards } from '../src/levelup.js';
import { megaChance } from '../src/mega.js';
import { restoreSim, TICK_HZ, type SimState } from '../src/index.js';
import { patchTuning, player, quietSim, seconds, steps } from './helpers.js';

const CHARIZARD = 6;
const PIKACHU = 25;
const KYOGRE = 382;

/** A sim at `minute` whose offers always hold the Unique card for a capable partner. */
function megaSim(dexes: number[], minute = 31, factor = 1000) {
  const sim = quietSim(
    dexes.map((dex, i) => ({ id: `p${i}`, dex })),
    { choiceTimeoutSeconds: null },
  );
  patchTuning(sim, 'mega', { legendaryFactor: factor });
  sim.state.time = minute * 60;
  return sim;
}

const hasMega = (cards: { type: string }[]) => cards.some((c) => c.type === 'mega');

/** Opens a level-up round and returns each player's choice. */
function levelUp(sim: ReturnType<typeof quietSim>) {
  sim.state.pendingLevels = 1;
  sim.step();
  return sim.state.pendingChoices;
}

describe('the Unique card', () => {
  it('is never offered before the start minute', () => {
    const sim = megaSim([CHARIZARD], 29.9);
    for (let i = 0; i < 200; i++) expect(hasMega(offerCards(sim.ctx, player(sim)))).toBe(false);
    expect(megaChance(sim.ctx, player(sim))).toBe(0);
  });

  it('is never offered to a partner that cannot Mega Evolve', () => {
    const sim = megaSim([PIKACHU], 60);
    for (let i = 0; i < 200; i++) expect(hasMega(offerCards(sim.ctx, player(sim)))).toBe(false);
  });

  it('is offered from the start minute, once per offer, in the last slot', () => {
    const sim = megaSim([CHARIZARD]);
    for (let i = 0; i < 50; i++) {
      const cards = offerCards(sim.ctx, player(sim));
      expect(cards.filter((c) => c.type === 'mega')).toEqual([{ id: 'mega:6', type: 'mega' }]);
      expect(cards.at(-1)?.type).toBe('mega');
      expect(cards.length).toBeLessThanOrEqual(sim.ctx.d.game.levelUp.cardsOffered);
    }
  });

  it('is half as likely per offer as an offer showing a Legendary card, by default', () => {
    const sim = quietSim([{ id: 'p0', dex: CHARIZARD }]);
    sim.state.time = 30 * 60;
    const w = sim.ctx.d.game.levelUp.rarity.odds.at(-1)!.weights;
    const p = w.at(-1)! / w.reduce((a, x) => a + x, 0);
    const k = sim.ctx.d.game.levelUp.cardsOffered;
    const legendaryOffer = 1 - (1 - p) ** k;
    expect(megaChance(sim.ctx, player(sim))).toBeCloseTo(
      sim.ctx.d.game.tuning.mega.legendaryFactor * legendaryOffer,
    );
    expect(sim.ctx.d.game.tuning.mega.legendaryFactor).toBe(0.5);
  });

  it('applies the boost once, changes the form and is not offered again', () => {
    const sim = megaSim([CHARIZARD]);
    const p = player(sim);
    const before = { atk: p.attackMul, spd: p.speedMul, cd: p.cooldownMul, hp: p.maxHp, r: p.r };
    p.hp = before.hp / 2;
    const [choice] = levelUp(sim);
    expect(choice?.kind).toBe('level-up');
    if (choice?.kind !== 'level-up') return;
    expect(resolveChoice(sim.ctx, choice, 'mega:6')).toEqual({ ok: true });
    const m = sim.ctx.d.game.tuning.mega;
    expect(p.megaAt).toBe(sim.state.time);
    expect(p.attackMul).toBeCloseTo(before.atk * m.attackMul);
    expect(p.speedMul).toBeCloseTo(before.spd * m.speedMul);
    expect(p.cooldownMul).toBeCloseTo(before.cd * m.cooldownMul);
    const added = Math.round(before.hp * (m.maxHpMul - 1));
    expect(p.maxHp).toBe(before.hp + added);
    // The HP added is healed.
    expect(p.hp).toBe(before.hp / 2 + added);
    // The body follows the form's sprite.
    expect(p.r).toBe(sim.ctx.d.game.megaBodyByDex.get(CHARIZARD)!.radius);
    expect(sim.drainEvents()).toContainEqual({
      type: 'mega-evolved',
      playerId: 'p0',
      dex: CHARIZARD,
      kind: 'mega',
    });
    expect(balanceRecord(sim.ctx, p)?.mega).toEqual({
      t: Math.round(sim.state.time * 1000) / 1000,
      form: '6-mega',
    });
    // Never again, and picking a stale card does nothing.
    expect(megaChance(sim.ctx, p)).toBe(0);
    for (let i = 0; i < 100; i++) expect(hasMega(offerCards(sim.ctx, p))).toBe(false);
  });

  it('can come back after being declined', () => {
    const sim = megaSim([KYOGRE]);
    const [first] = levelUp(sim);
    if (first?.kind !== 'level-up') throw new Error('no choice');
    const other = first.options.find((o) => o.type !== 'mega')!;
    resolveChoice(sim.ctx, first, other.id);
    expect(player(sim).megaAt).toBeNull();
    const [second] = levelUp(sim);
    expect(second?.kind === 'level-up' && hasMega(second.options)).toBe(true);
  });

  it('holds the pause for the animation, then the run clock goes on', () => {
    const sim = megaSim([CHARIZARD]);
    const [choice] = levelUp(sim);
    if (choice?.kind !== 'level-up') throw new Error('no choice');
    resolveChoice(sim.ctx, choice, 'mega:6');
    const t0 = sim.state.time;
    const hold = Math.round(sim.ctx.d.game.tuning.mega.animationSeconds * TICK_HZ);
    expect(hold).toBeGreaterThan(seconds(2));
    expect(sim.paused).toBe(true);
    steps(sim, hold - 1);
    expect(sim.paused).toBe(true);
    expect(sim.state.time).toBe(t0);
    steps(sim, 1);
    expect(sim.paused).toBe(false);
    steps(sim, 1);
    expect(sim.state.time).toBeGreaterThan(t0);
  });

  it('keeps the form, the boost and the pause through a save and restore', () => {
    const sim = megaSim([CHARIZARD]);
    const [choice] = levelUp(sim);
    if (choice?.kind !== 'level-up') throw new Error('no choice');
    resolveChoice(sim.ctx, choice, 'mega:6');
    steps(sim, 10);
    const saved = JSON.parse(JSON.stringify(sim.state)) as SimState;
    const back = restoreSim(saved);
    expect(back.state.players[0]?.megaAt).toBe(player(sim).megaAt);
    expect(back.state.players[0]?.attackMul).toBe(player(sim).attackMul);
    expect(back.state.megaTicks).toBe(sim.state.megaTicks);
    expect(back.hash()).toBe(sim.hash());
    steps(sim, 200);
    steps(back, 200);
    expect(back.hash()).toBe(sim.hash());
  });

  it('back-fills saves from before Mega Evolution', () => {
    const sim = megaSim([CHARIZARD]);
    const old = JSON.parse(JSON.stringify(sim.state)) as Partial<SimState>;
    delete old.megaTicks;
    for (const p of old.players ?? []) delete (p as { megaAt?: number | null }).megaAt;
    const back = restoreSim(old as SimState);
    expect(back.state.megaTicks).toBe(0);
    expect(back.state.players[0]?.megaAt).toBeNull();
    expect(back.paused).toBe(false);
  });

  it('works for each co-op player on their own', () => {
    const sim = megaSim([CHARIZARD, PIKACHU, KYOGRE]);
    const choices = levelUp(sim);
    const of = (id: string) => {
      const c = choices.find((x) => x.playerId === id);
      if (c?.kind !== 'level-up') throw new Error('no choice');
      return c;
    };
    expect(hasMega(of('p0').options)).toBe(true);
    expect(hasMega(of('p1').options)).toBe(false);
    expect(of('p2').options.at(-1)).toEqual({ id: 'mega:382', type: 'mega' });
    // Kyogre declines, Charizard Mega Evolves: only Charizard changes.
    resolveChoice(sim.ctx, of('p2'), of('p2').options[0]!.id);
    resolveChoice(sim.ctx, of('p0'), 'mega:6');
    resolveChoice(sim.ctx, of('p1'), of('p1').options[0]!.id);
    expect(sim.state.players.map((p) => p.megaAt !== null)).toEqual([true, false, false]);
    expect(sim.paused).toBe(true);
    // Kyogre can still get its own later.
    steps(sim, sim.state.megaTicks + 1);
    const again = levelUp(sim).find((c) => c.playerId === 'p2');
    expect(again?.kind === 'level-up' && hasMega(again.options)).toBe(true);
    if (again?.kind === 'level-up') resolveChoice(sim.ctx, again, 'mega:382');
    expect(player(sim, 2).megaAt).not.toBeNull();
    expect(balanceRecord(sim.ctx, player(sim, 2))?.mega?.form).toBe('382-primal');
  });

  it('the dev trigger offers it now', () => {
    const sim = quietSim([{ id: 'p0', dex: CHARIZARD }], { choiceTimeoutSeconds: null });
    expect(sim.debugOfferMega('p0')).toBe(true);
    const c = sim.state.pendingChoices[0];
    expect(c?.kind === 'level-up' && c.options.at(-1)?.type).toBe('mega');
    expect(c?.kind === 'level-up' && c.options.length).toBe(sim.ctx.d.game.levelUp.cardsOffered);
    const pika = quietSim([{ id: 'p0', dex: PIKACHU }]);
    expect(pika.debugOfferMega('p0')).toBe(false);
  });
});
