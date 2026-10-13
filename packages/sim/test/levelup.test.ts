import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { applyCard, offerCards } from '../src/levelup.js';
import { addMove } from '../src/moves.js';
import { giveMove, player, quietSim } from './helpers.js';

const d = simData();
const cfg = d.game.levelUp;

describe('level-up offers', () => {
  it('offers distinct cards, of the known kinds', () => {
    const sim = quietSim();
    const p = player(sim);
    for (let i = 0; i < 50; i++) {
      const cards = offerCards(sim.ctx, p);
      expect(cards.length).toBe(cfg.cardsOffered);
      expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
      for (const c of cards) {
        if (c.type === 'new') expect(d.movePool(p.types)).toContain(c.moveId);
        if (c.type === 'stat') expect(d.game.statCardById.has(c.statId!)).toBe(true);
        if (c.type === 'upgrade') expect(c.toLevel).toBe(2);
      }
    }
  });

  it('offers no new moves once the slots are full', () => {
    const sim = quietSim();
    const p = player(sim);
    for (const id of ['tackle', 'quick-attack', 'body-slam']) addMove(sim.ctx, p, id);
    expect(p.slots.length).toBe(cfg.maxMoveSlots);
    for (let i = 0; i < 50; i++) {
      expect(offerCards(sim.ctx, p).some((c) => c.type === 'new')).toBe(false);
    }
  });

  it('never offers banned moves or a third buff', () => {
    const sim = quietSim([
      { id: 'a', dex: 25, upgrades: { ban: 1 }, bannedMoves: ['thunderbolt', 'discharge'] },
    ]);
    const p = player(sim);
    expect(p.banned).toEqual(['thunderbolt']); // only as many as the upgrade allows
    addMove(sim.ctx, p, 'swords-dance');
    addMove(sim.ctx, p, 'agility');
    for (let i = 0; i < 100; i++) {
      for (const c of offerCards(sim.ctx, p)) {
        expect(c.moveId).not.toBe('thunderbolt');
        if (c.type === 'new') expect(d.move(c.moveId!).kind).not.toBe('buff');
      }
    }
  });

  it('respects stat card caps, except the card a waiting evolution needs', () => {
    const sim = quietSim();
    const p = player(sim);
    for (const c of cfg.statCards) if (c.maxPicks) p.statsTaken[c.id] = c.maxPicks;
    const capped = new Set(cfg.statCards.filter((c) => c.maxPicks).map((c) => c.id));
    for (let i = 0; i < 50; i++) {
      for (const c of offerCards(sim.ctx, p))
        if (c.type === 'stat') expect(capped.has(c.statId!)).toBe(false);
    }
    // A max-level move waiting for the (capped) attack card: that card shows up again.
    giveMove(sim, p, 'ember', 5);
    p.statsTaken.attack = 0;
    delete p.statsTaken.attack;
    const offers = Array.from({ length: 40 }, () => offerCards(sim.ctx, p).map((c) => c.id)).flat();
    expect(offers).toContain('stat:attack');
  });

  it('applies stat cards (with caps) and counts them', () => {
    const sim = quietSim();
    const p = player(sim);
    const hp = p.maxHp;
    applyCard(sim.ctx, p, { id: 'stat:max-hp', type: 'stat', statId: 'max-hp' });
    expect(p.maxHp).toBe(hp + 20);
    const atk = p.attackMul;
    applyCard(sim.ctx, p, { id: 'stat:attack', type: 'stat', statId: 'attack' });
    expect(p.attackMul).toBeCloseTo(atk * 1.1);
    for (let i = 0; i < 20; i++)
      applyCard(sim.ctx, p, { id: 'stat:defense', type: 'stat', statId: 'defense' });
    expect(p.damageReduction).toBeCloseTo(0.7);
    expect(p.statsTaken).toMatchObject({ 'max-hp': 1, attack: 1, defense: 20 });
  });

  it('learns, upgrades and switches to new moves', () => {
    const sim = quietSim();
    const p = player(sim);
    applyCard(sim.ctx, p, { id: 'new:tackle', type: 'new', moveId: 'tackle' });
    expect(p.slots.map((s) => s[0])).toContain('tackle');
    expect(p.slots[p.active]).toEqual(['tackle']);
    applyCard(sim.ctx, p, { id: 'upgrade:tackle', type: 'upgrade', moveId: 'tackle' });
    expect(p.moves.find((m) => m.id === 'tackle')!.level).toBe(2);
  });

  it('keeps bound moves in their chosen slot', () => {
    const sim = quietSim([{ id: 'a', dex: 25, moveBindings: [null, null, 'thunder-shock'] }]);
    const p = player(sim);
    addMove(sim.ctx, p, 'tackle');
    addMove(sim.ctx, p, 'quick-attack');
    expect(p.slots.map((s) => s[0])).toEqual(['tackle', 'quick-attack', 'thunder-shock']);
  });
});
