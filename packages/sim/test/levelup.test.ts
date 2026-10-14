import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { applyCard, offerCards } from '../src/levelup.js';
import { addMove } from '../src/moves.js';
import { giveMove, player, quietSim } from './helpers.js';

const d = simData();
const cfg = d.game.levelUp;
const hpEffect = d.statCard('max-hp').effect;
const attackEffect = d.statCard('attack').effect;
const defenseEffect = d.statCard('defense').effect;
if (hpEffect.type !== 'maxHp' || attackEffect.type !== 'stat' || defenseEffect.type !== 'stat')
  throw new Error('Expected max-HP, attack and defense stat cards');

describe('level-up offers', () => {
  it('offers distinct cards, of the known kinds', () => {
    const sim = quietSim();
    const p = player(sim);
    for (let i = 0; i < 50; i++) {
      const cards = offerCards(sim.ctx, p);
      expect(cards.length).toBeLessThanOrEqual(cfg.cardsOffered);
      expect(cards.length).toBeGreaterThan(0);
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
    for (const id of d.movePool(p.types)) {
      if (p.slots.length >= cfg.maxMoveSlots) break;
      addMove(sim.ctx, p, id);
    }
    expect(p.slots.length).toBe(cfg.maxMoveSlots);
    for (let i = 0; i < 50; i++) {
      expect(offerCards(sim.ctx, p).some((c) => c.type === 'new')).toBe(false);
    }
  });

  it('never offers banned moves or buffs beyond the configured cap', () => {
    const sim = quietSim([
      { id: 'a', dex: 25, upgrades: { ban: 1 }, bannedMoves: ['thunderbolt', 'discharge'] },
    ]);
    const p = player(sim);
    const ban = d.game.upgradeById.get('ban')!;
    expect(p.banned).toEqual(
      ['thunderbolt', 'discharge'].slice(0, Math.min(1, ban.maxLevel) * ban.perLevel),
    );
    const buffs = d.game.moves.moves.filter((m) => m.kind === 'buff');
    for (const buff of buffs.slice(0, cfg.maxBuffMoves)) addMove(sim.ctx, p, buff.id);
    for (let i = 0; i < 100; i++) {
      for (const c of offerCards(sim.ctx, p)) {
        expect(c.moveId).not.toBe('thunderbolt');
        if (c.type === 'new') expect(d.move(c.moveId!).kind).not.toBe('buff');
      }
    }
  });

  it("respects stat card caps and keeps a waiting evolution's required card eligible", () => {
    const sim = quietSim();
    const p = player(sim);
    for (const c of cfg.statCards) if (c.maxPicks) p.statsTaken[c.id] = c.maxPicks;
    const capped = new Set(cfg.statCards.filter((c) => c.maxPicks).map((c) => c.id));
    for (let i = 0; i < 50; i++) {
      for (const c of offerCards(sim.ctx, p))
        if (c.type === 'stat') expect(capped.has(c.statId!)).toBe(false);
    }
    // A max-level move waiting for the (capped) attack card: that card shows up again.
    giveMove(sim, p, 'ember', d.maxMoveLevel('ember'));
    p.statsTaken.attack = 0;
    delete p.statsTaken.attack;
    // Isolate eligibility from offer weights by leaving only the required card in the pool.
    p.maxSlots = p.slots.length;
    sim.ctx.d = {
      ...sim.ctx.d,
      game: { ...sim.ctx.d.game, levelUp: { ...cfg, statCards: [d.statCard('attack')] } },
    };
    const offers = offerCards(sim.ctx, p).map((c) => c.id);
    expect(offers).toContain('stat:attack');
  });

  it('applies stat cards (with caps) and counts them', () => {
    const sim = quietSim();
    const p = player(sim);
    const hp = p.maxHp;
    applyCard(sim.ctx, p, { id: 'stat:max-hp', type: 'stat', statId: 'max-hp' });
    expect(p.maxHp).toBe(hp + hpEffect.value);
    const atk = p.attackMul;
    applyCard(sim.ctx, p, { id: 'stat:attack', type: 'stat', statId: 'attack' });
    expect(p.attackMul).toBeCloseTo(atk * attackEffect.value);
    for (let i = 0; i < 20; i++)
      applyCard(sim.ctx, p, { id: 'stat:defense', type: 'stat', statId: 'defense' });
    expect(p.damageReduction).toBeCloseTo(
      Math.min(defenseEffect.cap ?? Infinity, 20 * defenseEffect.value),
    );
    expect(p.statsTaken).toMatchObject({ 'max-hp': 1, attack: 1, defense: 20 });
  });

  it('learns, upgrades and switches to new moves', () => {
    const sim = quietSim();
    const p = player(sim);
    p.maxSlots = Math.max(2, p.maxSlots); // Exercise learning with an available slot.
    applyCard(sim.ctx, p, { id: 'new:tackle', type: 'new', moveId: 'tackle' });
    expect(p.slots.map((s) => s[0])).toContain('tackle');
    expect(p.slots[p.active]).toEqual(['tackle']);
    applyCard(sim.ctx, p, { id: 'upgrade:tackle', type: 'upgrade', moveId: 'tackle' });
    expect(p.moves.find((m) => m.id === 'tackle')!.level).toBe(2);
  });

  it('keeps bound moves in their chosen slot', () => {
    const bound = Math.min(2, cfg.maxMoveSlots - 1);
    const bindings = Array.from({ length: bound + 1 }, (_, i) =>
      i === bound ? 'thunder-shock' : null,
    );
    const sim = quietSim([{ id: 'a', dex: 25, moveBindings: bindings }]);
    const p = player(sim);
    addMove(sim.ctx, p, 'tackle');
    addMove(sim.ctx, p, 'quick-attack');
    expect(p.slots[bound]).toEqual(['thunder-shock']);
    expect(p.slots.filter((_, i) => i !== bound).flat()).toEqual(
      ['tackle', 'quick-attack'].slice(0, cfg.maxMoveSlots - 1),
    );
  });
});
