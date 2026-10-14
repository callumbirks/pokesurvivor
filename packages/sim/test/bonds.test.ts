// Bonds: what a bond can do, fusing, and the `bond` choice (pause, deadline, disconnect, saved).
import { describe, expect, it } from 'vitest';
import { BOND_MAX, bondOptions, fuse } from '../src/bonds.js';
import { equip } from '../src/items.js';
import { activeGroup, addMove, newMove } from '../src/moves.js';
import type { Sim } from '../src/index.js';
import type { BondChoice, PlayerState } from '../src/state.js';
import { player, quietSim, seconds, steps } from './helpers.js';

/** Gives a player these moves, one slot each. */
function setMoves(sim: Sim, p: PlayerState, ids: string[]): void {
  p.moves = ids.map((id) => newMove(sim.ctx, id));
  p.slots = ids.map((id) => [id]);
  p.active = 0;
}

const bondOf = (sim: Sim, id: string) =>
  sim.state.pendingChoices.find((c): c is BondChoice => c.kind === 'bond' && c.playerId === id);

describe('bond options', () => {
  it('pair two loose moves; then grow the group; full group pairs again; null when nothing', () => {
    const sim = quietSim();
    const p = player(sim);
    setMoves(sim, p, ['tackle']);
    expect(bondOptions(p)).toBeNull();
    setMoves(sim, p, ['tackle', 'ember', 'water-gun']);
    expect(bondOptions(p)).toEqual({
      mode: 'pair',
      group: null,
      loose: ['tackle', 'ember', 'water-gun'],
    });
    fuse(sim.ctx, p, ['tackle', 'ember'], null);
    expect(bondOptions(p)).toEqual({
      mode: 'add',
      group: ['tackle', 'ember'],
      loose: ['water-gun'],
    });
    p.slots = [['tackle', 'ember', 'water-gun', 'vine-whip']];
    expect(BOND_MAX).toBe(4);
    expect(bondOptions(p)).toBeNull();
    p.slots.push(['bite'], ['lick']);
    expect(bondOptions(p)?.mode).toBe('pair');
  });

  it('fusing merges the slots, switches to the group and casts them together', () => {
    const sim = quietSim();
    const p = player(sim);
    setMoves(sim, p, ['tackle', 'ember', 'water-gun']);
    p.bonds = 1;
    fuse(sim.ctx, p, ['ember', 'water-gun'], null);
    expect(p.slots).toEqual([['tackle'], ['ember', 'water-gun']]);
    expect(activeGroup(p).map((m) => m.id)).toEqual(['ember', 'water-gun']);
    expect(p.bonds).toBe(0);
    fuse(sim.ctx, p, ['tackle'], ['ember', 'water-gun']);
    expect(p.slots).toEqual([['ember', 'water-gun', 'tackle']]);
  });

  it('with Choice Band you stay on your slot', () => {
    const sim = quietSim();
    const p = player(sim);
    setMoves(sim, p, ['tackle', 'ember', 'water-gun']);
    equip(sim.ctx, p, 'choice-band');
    fuse(sim.ctx, p, ['ember', 'water-gun'], null);
    expect(activeGroup(p).map((m) => m.id)).toEqual(['tackle']);
  });
});

describe('the bond choice', () => {
  it('is offered to each player with a bond and pauses everyone until picked', () => {
    const sim = quietSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    setMoves(sim, a, ['tackle', 'ember', 'water-gun']);
    setMoves(sim, b, ['tackle', 'ember']);
    a.bonds = b.bonds = 1;
    sim.step();
    const ca = bondOf(sim, a.id)!;
    const cb = bondOf(sim, b.id)!;
    expect(ca.mode).toBe('pair');
    expect(sim.paused).toBe(true);
    const t = sim.state.time;
    steps(sim, 10);
    expect(sim.state.time).toBe(t);

    // Invalid picks change nothing.
    for (const moves of [['tackle'], ['tackle', 'tackle'], ['tackle', 'bite'], []]) {
      expect(sim.submitIntent(a.id, { type: 'pickBond', choiceId: ca.id, moves }).ok).toBe(false);
    }
    expect(sim.submitIntent(a.id, { type: 'pickCard', choiceId: ca.id, cardId: 'x' }).ok).toBe(
      false,
    );
    expect(
      sim.submitIntent(b.id, { type: 'pickBond', choiceId: ca.id, moves: ['tackle', 'ember'] }).ok,
    ).toBe(false);

    expect(
      sim.submitIntent(a.id, {
        type: 'pickBond',
        choiceId: ca.id,
        moves: ['water-gun', 'tackle'],
      }).ok,
    ).toBe(true);
    expect(a.slots).toEqual([['ember'], ['water-gun', 'tackle']]);
    // A repeated intent is stale.
    expect(
      sim.submitIntent(a.id, { type: 'pickBond', choiceId: ca.id, moves: ['ember', 'tackle'] }).ok,
    ).toBe(false);
    expect(sim.paused).toBe(true);
    sim.submitIntent(b.id, { type: 'pickBond', choiceId: cb.id, moves: ['tackle', 'ember'] });
    expect(sim.paused).toBe(false);
    expect(b.slots).toEqual([['tackle', 'ember']]);
  });

  it('auto-resolves to the first moves at its deadline', () => {
    const sim = quietSim(1, { choiceTimeoutSeconds: 2 });
    const p = player(sim);
    setMoves(sim, p, ['tackle', 'ember', 'water-gun']);
    p.bonds = 1;
    sim.step();
    expect(bondOf(sim, p.id)).toBeDefined();
    steps(sim, seconds(2) + 1);
    expect(sim.state.pendingChoices).toEqual([]);
    expect(p.slots).toEqual([['tackle', 'ember'], ['water-gun']]);
    expect(p.bonds).toBe(0);
  });

  it('a disconnect resolves it at once; a disconnected player is not offered one', () => {
    const sim = quietSim(2);
    const [a, b] = [player(sim, 0), player(sim, 1)];
    setMoves(sim, a, ['tackle', 'ember']);
    setMoves(sim, b, ['tackle', 'ember']);
    a.bonds = 1;
    sim.step();
    expect(bondOf(sim, a.id)).toBeDefined();
    sim.setConnected(a.id, false);
    expect(sim.state.pendingChoices).toEqual([]);
    expect(a.slots).toEqual([['tackle', 'ember']]);

    sim.setConnected(b.id, false);
    b.bonds = 1;
    steps(sim, 5);
    expect(bondOf(sim, b.id)).toBeUndefined();
    sim.setConnected(b.id, true);
    sim.step();
    expect(bondOf(sim, b.id)).toBeDefined();
  });

  it('is saved until there are two loose moves', () => {
    const sim = quietSim();
    const p = player(sim);
    setMoves(sim, p, ['tackle']);
    p.bonds = 1;
    steps(sim, 30);
    expect(sim.state.pendingChoices).toEqual([]);
    p.maxSlots = Math.max(2, p.maxSlots); // The pair fixture needs room for its second move.
    addMove(sim.ctx, p, 'ember');
    sim.step();
    expect(bondOf(sim, p.id)?.loose).toEqual(['tackle', 'ember']);
  });

  it('is not offered while down or in the arena', () => {
    const sim = quietSim(2, { debug: { invulnerable: true } });
    const p = player(sim);
    setMoves(sim, p, ['tackle', 'ember']);
    p.bonds = 1;
    p.dead = true;
    steps(sim, 5);
    expect(sim.state.pendingChoices).toEqual([]);
    p.dead = false;
    sim.debugStartArena();
    steps(sim, 5);
    expect(bondOf(sim, p.id)).toBeUndefined();
  });
});
