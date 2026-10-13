import type { ChoiceRef, IntentResult } from '@pokesurvivor/netclient';
import type { Intent, PendingChoice } from '@pokesurvivor/sim';
import { describe, expect, it } from 'vitest';
import { ChoiceState, type ChoiceSnapshot } from './choices.js';

const levelUp = (
  id: number,
  cards = ['new:ember', 'upgrade:tackle', 'stat:speed'],
): PendingChoice => ({
  id,
  playerId: 'me',
  kind: 'level-up',
  level: 3,
  deadlineTick: 900,
  options: cards.map((c) => ({ id: c, type: c.split(':')[0] as 'new' })),
});
const item: PendingChoice = {
  id: 7,
  playerId: 'me',
  kind: 'item',
  held: 'leftovers',
  found: 'life-orb',
  deadlineTick: null,
};
const bond = (mode: 'pair' | 'add'): PendingChoice => ({
  id: 9,
  playerId: 'me',
  kind: 'bond',
  mode,
  group: mode === 'add' ? ['ember', 'tackle'] : null,
  loose: ['gust', 'bite', 'ember'],
  deadlineTick: 600,
});
const ref = (c: {
  id: number;
  playerId: string;
  kind: string;
  deadlineTick: number | null;
}): ChoiceRef => ({
  id: c.id,
  playerId: c.playerId,
  kind: c.kind,
  deadlineTick: c.deadlineTick,
});

function setup(reply: (i: Intent) => IntentResult = () => ({ ok: true })) {
  const sent: Intent[] = [];
  let now = 0;
  const pending: (() => void)[] = [];
  const state = new ChoiceState(
    'me',
    30,
    (id) => ({ me: 'Ash', p2: 'Misty', p3: 'Brock' })[id] ?? id,
    (i) => {
      sent.push(i);
      return new Promise((res) => pending.push(() => res(reply(i))));
    },
    () => now,
  );
  const snap = (
    choices: PendingChoice[],
    others: ChoiceRef[] = [],
    tick = 0,
    rerollsLeft = 1,
  ): ChoiceSnapshot => ({ tick, choices, waiting: [...choices.map(ref), ...others], rerollsLeft });
  return {
    state,
    sent,
    snap,
    advance(ms: number) {
      now += ms;
    },
    /** Delivers the intent replies. */
    async flush() {
      for (const p of pending.splice(0)) p();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('the choice overlay state', () => {
  it('opens for a level-up, counts down to the deadline and sends the card picked', async () => {
    const h = setup();
    h.state.sync(h.snap([levelUp(1)], [], 0));
    const v = h.state.view()!;
    expect(v.choice.kind).toBe('level-up');
    expect(v.options.map((o) => o.id)).toEqual(['new:ember', 'upgrade:tackle', 'stat:speed']);
    expect(v.secondsLeft).toBe(30);
    h.state.sync(h.snap([levelUp(1)], [], 299));
    expect(h.state.view()!.secondsLeft).toBe(21);
    expect(h.state.pick(1)).toEqual({ type: 'pickCard', choiceId: 1, cardId: 'upgrade:tackle' });
    expect(h.state.view()!.submitted).toBe(true);
    expect(h.state.view()!.options[1]!.picked).toBe(true);
    // A second click while waiting does nothing.
    expect(h.state.pick(0)).toBeNull();
    await h.flush();
    // The server resolved it: the next snapshot no longer has it, and the overlay closes.
    h.state.sync(h.snap([], [], 300));
    expect(h.state.view()).toBeNull();
    expect(h.sent).toHaveLength(1);
  });

  it('closes when the choice vanishes without our pick (deadline, disconnect, run over)', () => {
    const h = setup();
    h.state.sync(h.snap([levelUp(1)]));
    expect(h.state.view()).not.toBeNull();
    h.state.sync(h.snap([]));
    expect(h.state.view()).toBeNull();
    expect(h.state.pick(0)).toBeNull();
  });

  it('shows which teammates are still choosing, with their deadline', () => {
    const h = setup();
    const theirs = [
      ref({ id: 2, playerId: 'p2', kind: 'level-up', deadlineTick: 450 }),
      ref({ id: 3, playerId: 'p3', kind: 'item', deadlineTick: 300 }),
      ref({ id: 4, playerId: 'p2', kind: 'bond', deadlineTick: 600 }),
    ];
    h.state.sync(h.snap([levelUp(1)], theirs, 0));
    expect(h.state.waiting()).toEqual({ others: ['Misty', 'Brock'], secondsLeft: 10 });
    // We picked; they're still on theirs: the game stays paused, and we see for whom.
    h.state.sync(h.snap([], theirs.slice(0, 1), 90));
    expect(h.state.view()).toBeNull();
    expect(h.state.waiting()).toEqual({ others: ['Misty'], secondsLeft: 12 });
    h.state.sync(h.snap([], [], 91));
    expect(h.state.waiting()).toBeNull();
  });

  it('lets the player pick again when the server refuses, or the reply never comes', async () => {
    const h = setup(() => ({ ok: false, error: 'no such level-up choice' }));
    h.state.sync(h.snap([levelUp(1)]));
    h.state.pick(0);
    expect(h.state.view()!.submitted).toBe(true);
    await h.flush();
    expect(h.state.view()!.submitted).toBe(false);

    const lost = setup();
    lost.state.sync(lost.snap([levelUp(1)]));
    lost.state.pick(2);
    lost.advance(1000);
    lost.state.sync(lost.snap([levelUp(1)]));
    expect(lost.state.view()!.submitted).toBe(true);
    lost.advance(2000);
    lost.state.sync(lost.snap([levelUp(1)]));
    expect(lost.state.view()!.submitted).toBe(false);
    expect(lost.state.pick(2)).toEqual({ type: 'pickCard', choiceId: 1, cardId: 'stat:speed' });
    expect(lost.sent).toHaveLength(2);
  });

  it('rerolls level-up cards while rerolls are left, and shows the new ones', async () => {
    const h = setup();
    h.state.sync(h.snap([levelUp(1)], [], 0, 1));
    expect(h.state.view()!.rerollsLeft).toBe(1);
    expect(h.state.reroll()).toEqual({ type: 'reroll', choiceId: 1 });
    await h.flush();
    h.state.sync(h.snap([levelUp(1, ['new:gust', 'stat:attack', 'stat:regen'])], [], 1, 0));
    const v = h.state.view()!;
    expect(v.submitted).toBe(false);
    expect(v.rerollsLeft).toBe(0);
    expect(v.options[0]!.id).toBe('new:gust');
    expect(h.state.reroll()).toBeNull();
  });

  it('keeps or swaps a held item', () => {
    const h = setup();
    h.state.sync(h.snap([item]));
    const v = h.state.view()!;
    expect(v.options.map((o) => o.id)).toEqual(['leftovers', 'life-orb']);
    expect(v.secondsLeft).toBeNull(); // solo: no deadline
    expect(v.rerollsLeft).toBe(0);
    expect(h.state.reroll()).toBeNull();
    expect(h.state.pick(1)).toEqual({ type: 'pickItem', choiceId: 7, itemId: 'life-orb' });
  });

  it('bonds two loose moves in two steps, with a way back', () => {
    const h = setup();
    h.state.sync(h.snap([bond('pair')]));
    expect(h.state.pick(1)).toBeNull(); // first: bite
    let v = h.state.view()!;
    expect(v.first).toBe('bite');
    expect(v.options.map((o) => o.id)).toEqual(['gust', 'ember']);
    h.state.back();
    expect(h.state.view()!.first).toBeNull();
    h.state.pick(0); // gust
    expect(h.state.pick(1)).toEqual({ type: 'pickBond', choiceId: 9, moves: ['gust', 'ember'] });
    v = h.state.view()!;
    expect(v.submitted).toBe(true);
  });

  it('adds one move to a bonded group in one step', () => {
    const h = setup();
    h.state.sync(h.snap([bond('add')]));
    expect(h.state.pick(2)).toEqual({ type: 'pickBond', choiceId: 9, moves: ['ember'] });
  });

  it('moves on to the next choice when there are several (a level-up after an item swap)', () => {
    const h = setup();
    h.state.sync(h.snap([levelUp(5), item]));
    expect(h.state.view()!.choice.id).toBe(5);
    h.state.pick(0);
    h.state.sync(h.snap([item]));
    const v = h.state.view()!;
    expect(v.choice.id).toBe(7);
    expect(v.submitted).toBe(false);
  });

  it('re-renders only when something on screen changes', () => {
    const h = setup();
    h.state.sync(h.snap([levelUp(1)], [], 0));
    const v0 = h.state.version;
    h.state.sync(h.snap([levelUp(1)], [], 5)); // same second
    expect(h.state.version).toBe(v0);
    h.state.sync(h.snap([levelUp(1)], [], 40)); // a second later
    expect(h.state.version).toBeGreaterThan(v0);
  });
});
