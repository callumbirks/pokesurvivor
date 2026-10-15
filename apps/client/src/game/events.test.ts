import { describe, expect, it, vi } from 'vitest';
import { audio } from '../audio.js';
import { typeColor } from '../icons.js';
import { EventEffects, hurtColor, type EventSinks } from './events.js';
import { FX } from './scene/fx.js';
import type { Frame } from './frame.js';

describe('damage number colours', () => {
  const hit = { shielded: false, label: null, moveType: 'fire' } as const;

  it("uses the attack's type colour", () => {
    expect(hurtColor(hit)).toBe(typeColor('fire'));
    expect(hurtColor({ ...hit, moveType: 'water' })).toBe(typeColor('water'));
    expect(typeColor('fire')).not.toBe(typeColor('water'));
  });

  it('is white for untyped hits (bombs, traps) and older servers', () => {
    expect(hurtColor({ ...hit, moveType: null })).toBe('#ffffff');
    expect(hurtColor({ shielded: false, label: null })).toBe('#ffffff');
  });

  it('lets the hit label and the shield win over the type', () => {
    expect(hurtColor({ ...hit, label: 'crit' })).toBe('#ff9a3c');
    expect(hurtColor({ ...hit, label: 'super' })).toBe('#ffe14d');
    expect(hurtColor({ ...hit, label: 'weak' })).toBe('#a3abb8');
    expect(hurtColor({ ...hit, shielded: true })).toBe('#9fd8ff');
  });
});

it('shows a green pulse and amount on the healed recipient', () => {
  const fx = new FX();
  const ring = vi.spyOn(fx, 'ring');
  const text = vi.spyOn(fx, 'text');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  // This event touches only FX and the recipient list; the other sinks are deliberately absent.
  const effects = new EventEffects({ fx } as EventSinks);
  const frame = { self: null, selfId: 'p0', enemies: [] } as unknown as Frame;
  effects.play([{ type: 'enemy-healed', id: 7, x: 20, y: 30, amount: 27.9 }], frame);
  expect(ring).toHaveBeenCalledWith(
    20,
    expect.any(Number),
    expect.any(Number),
    expect.any(Number),
    '#5fe08a',
    0.4,
    2,
  );
  expect(text).toHaveBeenCalledWith(20, 2, '+28', '#5fe08a');
  expect(errors).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('revives', () => {
  function setup() {
    const fx = new FX();
    const ring = vi.spyOn(fx, 'ring');
    const glow = vi.fn();
    const sfx = vi.spyOn(audio, 'sfx').mockImplementation(() => {});
    const entities = { playerHeight: () => 20 } as unknown as EventSinks['entities'];
    const effects = new EventEffects({ fx, entities, glow } as unknown as EventSinks);
    const frame = {
      self: { x: 0, y: 0 },
      selfId: 'me',
      players: [
        { id: 'me', x: 10, y: 10 },
        { id: 'bork', x: 50, y: 50 },
      ],
    } as unknown as Frame;
    return { effects, frame, ring, glow, sfx };
  }

  it('gives our own revive a bigger effect, a glow and its own sound', () => {
    const { effects, frame, ring, glow, sfx } = setup();
    effects.play([{ type: 'player-revived', playerId: 'me', by: 'bork' }], frame);
    expect(ring).toHaveBeenCalledTimes(2);
    expect(glow).toHaveBeenCalledWith('#5fe08a', expect.any(Number));
    expect(sfx).toHaveBeenCalledWith('revived', undefined);
    vi.restoreAllMocks();
  });

  it("keeps a teammate's revive as it was", () => {
    const { effects, frame, ring, glow, sfx } = setup();
    effects.play([{ type: 'player-revived', playerId: 'bork', by: 'me' }], frame);
    expect(ring).toHaveBeenCalledTimes(1);
    expect(glow).not.toHaveBeenCalled();
    expect(sfx).toHaveBeenCalledWith('heal', undefined);
    vi.restoreAllMocks();
  });
});
