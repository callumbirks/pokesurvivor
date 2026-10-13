// @vitest-environment happy-dom
import type { ChoiceRef } from '@pokesurvivor/netclient';
import type { PendingChoice } from '@pokesurvivor/sim';
import { describe, expect, it, vi } from 'vitest';
import { ChoiceOverlay } from './choice-ui.js';
import { ChoiceState, type ChoiceSnapshot } from './choices.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', () => ({
  iconImg: () => document.createElement('img'),
  typeColor: () => '#ffffff',
}));

const levelUp = (cards: string[], deadlineTick: number | null = 900): PendingChoice => ({
  id: 1,
  playerId: 'me',
  kind: 'level-up',
  level: 3,
  deadlineTick,
  options: cards.map((c) => ({
    id: c,
    type: c.split(':')[0] as 'new',
    moveId: c.split(':')[1],
  })),
});
const theirs: ChoiceRef = { id: 2, playerId: 'p2', kind: 'level-up', deadlineTick: 900 };

function setup() {
  const parent = document.createElement('div');
  const state = new ChoiceState(
    'me',
    30,
    (id) => (id === 'p2' ? 'Misty' : id),
    () => Promise.resolve({ ok: true }),
  );
  const overlay = new ChoiceOverlay(parent, state);
  const show = (s: ChoiceSnapshot) => {
    state.sync(s);
    overlay.update();
  };
  const cards = () => [...parent.querySelectorAll('.ps-card')];
  return { parent, state, overlay, show, cards };
}

const snap = (
  choices: PendingChoice[],
  tick: number,
  waiting: ChoiceRef[] = [],
  rerollsLeft = 1,
): ChoiceSnapshot => ({
  tick,
  choices,
  waiting: [
    ...choices.map((c) => ({
      id: c.id,
      playerId: c.playerId,
      kind: c.kind,
      deadlineTick: c.deadlineTick,
    })),
    ...waiting,
  ],
  rerollsLeft,
});

describe('the choice overlay DOM', () => {
  it('keeps the same box and cards across repeated snapshots of the same choice', () => {
    const h = setup();
    const cards = ['new:ember', 'upgrade:tackle', 'stat:speed'];
    // Every snapshot is a fresh object, as decoded from the network or the solo worker.
    h.show(snap([levelUp(cards)], 0, [theirs]));
    const box = h.parent.querySelector('.ps-box');
    const before = h.cards();
    expect(before).toHaveLength(3);
    expect(h.parent.querySelector('[data-testid=deadline]')?.textContent).toBe('30 s');
    // Three seconds of co-op snapshots at 20 Hz (the countdown ticks, the teammate is still
    // choosing), then of solo frames at 30 Hz (no deadline).
    for (let tick = 1; tick <= 90; tick += 1.5)
      h.show(snap([levelUp(cards)], Math.round(tick), [theirs]));
    expect(h.parent.querySelector('.ps-box')).toBe(box);
    expect(h.cards()).toEqual(before);
    h.cards().forEach((c, i) => expect(c).toBe(before[i]));
    // The live parts did change.
    expect(h.parent.querySelector('[data-testid=deadline]')?.textContent).toBe('27 s');
    expect(h.parent.textContent).toContain('Misty');
    h.show(snap([levelUp(cards)], 91, []));
    expect(h.parent.textContent).not.toContain('Misty');
    expect(h.cards()).toEqual(before);

    const solo = setup();
    solo.show(snap([levelUp(cards, null)], 0));
    const soloCards = solo.cards();
    for (let tick = 1; tick <= 90; tick++) solo.show(snap([levelUp(cards, null)], tick));
    solo.cards().forEach((c, i) => expect(c).toBe(soloCards[i]));
    expect(solo.parent.querySelector('[data-testid=deadline]')?.classList.contains('hidden')).toBe(
      true,
    );
  });

  it('rebuilds the cards after a reroll (same box), and makes a new box for the next choice', () => {
    const h = setup();
    h.show(snap([levelUp(['new:ember', 'upgrade:tackle', 'stat:speed'])], 0));
    const box = h.parent.querySelector('.ps-box');
    const before = h.cards();
    h.show(snap([levelUp(['new:gust', 'stat:attack', 'stat:regen'])], 40, [], 0));
    expect(h.parent.querySelector('.ps-box')).toBe(box);
    expect(h.cards()[0]).not.toBe(before[0]);
    expect(h.parent.querySelector('[data-testid=reroll]')).toBeNull();
    h.show(snap([], 41));
    expect(h.parent.querySelector('.ps-box')).toBeNull();
    h.show(snap([{ ...levelUp(['new:bite']), id: 5 }], 60));
    expect(h.parent.querySelector('.ps-box')).not.toBe(box);
  });

  it('labels the reroll button "Reroll" with the count and the R key', () => {
    const h = setup();
    h.show(snap([levelUp(['new:ember', 'upgrade:tackle', 'stat:speed'])], 0, [], 2));
    expect(h.parent.querySelector('[data-testid=reroll]')?.textContent).toBe('Reroll (2) · R');
  });
});
