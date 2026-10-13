import { describe, expect, it } from 'vitest';
import { offerItem } from '../src/items.js';
import { gainTeamXp, xpFor } from '../src/team.js';
import type { Sim } from '../src/index.js';
import type { PendingChoice } from '../src/state.js';
import { player, quietSim, seconds, steps } from './helpers.js';

/** Enough XP for exactly `n` team levels from level 1. */
function levelUp(sim: Sim, n = 1): void {
  let xp = 0;
  for (let l = sim.state.team.level; l < sim.state.team.level + n; l++) xp += xpFor(l);
  // gainTeamXp applies the team factor; undo it so the levels are exact.
  const f = sim.state.players.filter((p) => p.connected && !p.left);
  const avg = f.reduce((a, p) => a + p.xpMul, 0) / f.length;
  gainTeamXp(sim.ctx, (xp + 0.01) / (avg / (1 + 0.6 * (f.length - 1))));
}

const choicesOf = (sim: Sim, id: string): PendingChoice[] =>
  sim.state.pendingChoices.filter((c) => c.playerId === id);

const pick = (sim: Sim, c: PendingChoice) =>
  c.kind === 'level-up'
    ? sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: c.options[0]!.id })
    : c.kind === 'item'
      ? sim.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.found })
      : sim.submitIntent(c.playerId, {
          type: 'pickBond',
          choiceId: c.id,
          moves: c.loose.slice(0, 2),
        });

describe('level-up choices', () => {
  it('offer every player their own cards and pause the game until all pick', () => {
    const sim = quietSim(3);
    levelUp(sim);
    steps(sim, 1);
    expect(sim.state.pendingChoices.length).toBe(3);
    expect(new Set(sim.state.pendingChoices.map((c) => c.playerId)).size).toBe(3);
    expect(sim.paused).toBe(true);
    const time = sim.state.time;
    steps(sim, 10);
    expect(sim.state.time).toBe(time); // paused for everyone
    const [a, b, c] = sim.state.pendingChoices;
    expect(pick(sim, a!).ok).toBe(true);
    steps(sim, 1);
    expect(sim.state.time).toBe(time); // still waiting for two
    pick(sim, b!);
    pick(sim, c!);
    steps(sim, 1);
    expect(sim.paused).toBe(false);
    expect(sim.state.time).toBeGreaterThan(time);
  });

  it('hand out several level-ups one round at a time', () => {
    const sim = quietSim(2);
    levelUp(sim, 3);
    expect(sim.state.team.level).toBe(4);
    for (let round = 0; round < 3; round++) {
      steps(sim, 1);
      expect(sim.state.pendingChoices.length).toBe(2);
      for (const c of sim.state.pendingChoices.slice()) pick(sim, c);
    }
    steps(sim, 1);
    expect(sim.state.pendingChoices.length).toBe(0);
  });

  it('auto-resolve to the first card at the deadline', () => {
    const sim = quietSim(2, { choiceTimeoutSeconds: 5 });
    levelUp(sim);
    steps(sim, 1);
    const c = sim.state.pendingChoices[0]!;
    expect(c.deadlineTick).toBe(sim.state.tick + seconds(5));
    const first = c.kind === 'level-up' ? c.options[0] : undefined;
    pick(sim, sim.state.pendingChoices[1]!);
    steps(sim, seconds(5) - 2);
    expect(sim.paused).toBe(true);
    steps(sim, 2);
    expect(sim.paused).toBe(false);
    const auto = sim.drainEvents().find((e) => e.type === 'choice-resolved' && e.auto);
    expect(auto).toBeDefined();
    // The first card was applied: e.g. a new move or a stat taken.
    const p = player(sim, 0);
    if (first?.type === 'new') expect(p.moves.some((m) => m.id === first.moveId)).toBe(true);
    if (first?.type === 'stat') expect(p.statsTaken[first.statId!]).toBe(1);
  });

  it('never time out in solo when the timeout is off', () => {
    const sim = quietSim(1, { choiceTimeoutSeconds: null });
    levelUp(sim);
    steps(sim, seconds(120));
    expect(sim.paused).toBe(true);
    expect(sim.state.pendingChoices[0]!.deadlineTick).toBeNull();
  });

  it('auto-resolve at once when that player disconnects, without stalling the others', () => {
    const sim = quietSim(4);
    levelUp(sim);
    steps(sim, 1);
    for (const c of sim.state.pendingChoices.filter((c) => c.playerId !== 'p2')) pick(sim, c);
    expect(sim.paused).toBe(true);
    sim.setConnected('p2', false);
    expect(sim.paused).toBe(false);
    const t = sim.state.time;
    steps(sim, 1);
    expect(sim.state.time).toBeGreaterThan(t);
  });

  it('skip a disconnected player at the next level-up (their card is auto-picked)', () => {
    const sim = quietSim(2);
    sim.setConnected('p1', false);
    const moves = player(sim, 1).moves.length + Object.keys(player(sim, 1).statsTaken).length;
    levelUp(sim);
    steps(sim, 1);
    expect(choicesOf(sim, 'p1')).toEqual([]);
    expect(choicesOf(sim, 'p0').length).toBe(1);
    const p1 = player(sim, 1);
    const after = p1.moves.length + Object.keys(p1.statsTaken).length;
    const healed = sim
      .drainEvents()
      .some((e) => e.type === 'choice-resolved' && e.playerId === 'p1' && e.auto);
    expect(healed).toBe(true);
    expect(after).toBeGreaterThanOrEqual(moves);
  });

  it('resolve when the player leaves for good', () => {
    const sim = quietSim(2);
    levelUp(sim);
    steps(sim, 1);
    pick(sim, choicesOf(sim, 'p0')[0]!);
    sim.removePlayer('p1');
    expect(sim.paused).toBe(false);
  });

  it('reject cards that were not offered and choices of someone else', () => {
    const sim = quietSim(2);
    levelUp(sim);
    steps(sim, 1);
    const c = choicesOf(sim, 'p0')[0]!;
    expect(
      sim.submitIntent('p0', { type: 'pickCard', choiceId: c.id, cardId: 'stat:nope' }).ok,
    ).toBe(false);
    expect(sim.submitIntent('p1', { type: 'pickCard', choiceId: c.id, cardId: 'x' }).ok).toBe(
      false,
    );
    expect(sim.state.pendingChoices.length).toBe(2);
    // Picking twice: the second is refused.
    expect(pick(sim, c).ok).toBe(true);
    expect(pick(sim, c).ok).toBe(false);
  });

  it('reroll: one free per run plus the upgrade levels', () => {
    const sim = quietSim([{ id: 'a', dex: 25, upgrades: { reroll: 2 } }]);
    levelUp(sim);
    steps(sim, 1);
    const c = sim.state.pendingChoices[0]!;
    for (let i = 0; i < 3; i++)
      expect(sim.submitIntent('a', { type: 'reroll', choiceId: c.id }).ok).toBe(true);
    expect(sim.submitIntent('a', { type: 'reroll', choiceId: c.id }).ok).toBe(false);
    expect(c.kind === 'level-up' && c.options.length).toBe(3);
  });
});

describe('item choices', () => {
  it('equip at once when holding nothing; choose when holding another', () => {
    const sim = quietSim(2);
    const p = player(sim);
    offerItem(sim.ctx, p, 'leftovers');
    expect(p.item).toBe('leftovers');
    expect(sim.paused).toBe(false);
    offerItem(sim.ctx, p, 'leftovers'); // same one: nothing to choose
    expect(sim.paused).toBe(false);
    offerItem(sim.ctx, p, 'quick-claw');
    expect(sim.paused).toBe(true);
    const c = sim.state.pendingChoices[0]!;
    expect(c).toMatchObject({
      kind: 'item',
      held: 'leftovers',
      found: 'quick-claw',
      playerId: 'p0',
    });
    expect(
      sim.submitIntent('p0', { type: 'pickItem', choiceId: c.id, itemId: 'quick-claw' }).ok,
    ).toBe(true);
    expect(p.item).toBe('quick-claw');
    expect(sim.paused).toBe(false);
  });

  it('keep the held item when it times out', () => {
    const sim = quietSim(2, { choiceTimeoutSeconds: 1 });
    const p = player(sim);
    offerItem(sim.ctx, p, 'leftovers');
    offerItem(sim.ctx, p, 'quick-claw');
    steps(sim, seconds(1) + 1);
    expect(sim.paused).toBe(false);
    expect(p.item).toBe('leftovers');
  });

  it('overlapping choices for the same player are separate entries', () => {
    const sim = quietSim(2);
    const p = player(sim);
    offerItem(sim.ctx, p, 'leftovers');
    // Two items picked up on the same tick.
    offerItem(sim.ctx, p, 'quick-claw');
    offerItem(sim.ctx, p, 'lucky-egg');
    const mine = choicesOf(sim, 'p0');
    expect(mine.length).toBe(2);
    expect(new Set(mine.map((c) => c.id)).size).toBe(2);
    // Resolving one leaves the other pending (legacy's Set of names cleared both).
    pick(sim, mine[0]!);
    expect(p.item).toBe('quick-claw');
    const rest = choicesOf(sim, 'p0');
    expect(rest).toMatchObject([{ kind: 'item', held: 'quick-claw', found: 'lucky-egg' }]);
    expect(sim.paused).toBe(true);
    // Keeping the held one now keeps Quick Claw, not the stale Leftovers.
    const c = rest[0]!;
    expect(
      c.kind === 'item' &&
        sim.submitIntent('p0', { type: 'pickItem', choiceId: c.id, itemId: c.held }).ok,
    ).toBe(true);
    expect(p.item).toBe('quick-claw');
    expect(sim.paused).toBe(false);
  });

  it('level-up cards wait for a pending item swap, then follow', () => {
    const sim = quietSim(2);
    const p = player(sim);
    offerItem(sim.ctx, p, 'leftovers');
    offerItem(sim.ctx, p, 'quick-claw');
    levelUp(sim);
    steps(sim, 3);
    expect(sim.state.pendingChoices.map((c) => c.kind)).toEqual(['item']);
    pick(sim, sim.state.pendingChoices[0]!);
    steps(sim, 1);
    expect(sim.state.pendingChoices.map((c) => c.kind)).toEqual(['level-up', 'level-up']);
  });

  it("a disconnect clears all of that player's overlapping choices", () => {
    const sim = quietSim(2);
    const p = player(sim);
    offerItem(sim.ctx, p, 'leftovers');
    offerItem(sim.ctx, p, 'quick-claw');
    offerItem(sim.ctx, p, 'lucky-egg');
    expect(choicesOf(sim, 'p0').length).toBe(2);
    sim.setConnected('p0', false);
    expect(sim.state.pendingChoices).toEqual([]);
    expect(p.item).toBe('leftovers');
  });
});
