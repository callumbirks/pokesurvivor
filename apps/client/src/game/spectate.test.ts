import { describe, expect, it, vi } from 'vitest';
import { Spectator } from './spectate.js';

interface P {
  id: string;
  index: number;
  dead: boolean;
  connected: boolean;
  left: boolean;
}

/** `me` is down, in the room's order me, bork, leon, cynthia (index), listed out of order. */
function setup(patch: Record<string, Partial<P>> = {}) {
  const players: P[] = ['leon', 'me', 'cynthia', 'bork'].map((id) => ({
    id,
    index: ['me', 'bork', 'leon', 'cynthia'].indexOf(id),
    dead: id === 'me',
    connected: true,
    left: false,
    ...patch[id],
  }));
  const send = vi.fn<(target: string | null) => void>();
  const spec = new Spectator('me', send);
  spec.update(players);
  const set = (id: string, p: Partial<P>) => {
    Object.assign(
      players.find((x) => x.id === id)!,
      p,
    );
    spec.update(players);
  };
  return { spec, send, set };
}

describe('Spectator', () => {
  it('starts on the first teammate who is up, not ourselves, and tells the server', () => {
    const { spec, send } = setup({ bork: { dead: true } });
    expect(spec.available).toBe(true);
    expect(spec.target).toBe('me');
    spec.toggle();
    expect(spec.active).toBe(true);
    expect(spec.target).toBe('leon');
    expect(send).toHaveBeenLastCalledWith('leon');
    spec.toggle();
    expect(spec.active).toBe(false);
    expect(spec.target).toBe('me');
    expect(send).toHaveBeenLastCalledWith(null);
  });

  it('falls back to a downed teammate when nobody else is up', () => {
    const { spec } = setup({ bork: { dead: true }, leon: { dead: true }, cynthia: { left: true } });
    spec.toggle();
    expect(spec.target).toBe('bork');
  });

  it('cycles through everyone present in the room’s order, ourselves included', () => {
    const { spec, send } = setup();
    spec.toggle();
    expect(spec.target).toBe('bork');
    spec.cycle(1);
    expect(spec.target).toBe('leon');
    spec.cycle(1);
    expect(spec.target).toBe('cynthia');
    spec.cycle(1);
    // Ourselves: still spectating (the label stays), and the server centres on us again.
    expect(spec.target).toBe('me');
    expect(spec.active).toBe(true);
    expect(send).toHaveBeenLastCalledWith(null);
    spec.cycle(1);
    expect(spec.target).toBe('bork');
    spec.cycle(-1);
    spec.cycle(-1);
    expect(spec.target).toBe('cynthia');
  });

  it('skips players who left or are offline, and moves off a target who goes', () => {
    const { spec, set, send } = setup({ leon: { connected: false } });
    spec.toggle();
    spec.cycle(1);
    expect(spec.target).toBe('cynthia');
    set('cynthia', { left: true });
    expect(spec.target).toBe('me');
    spec.cycle(1);
    expect(spec.target).toBe('bork');
    set('leon', { connected: true });
    set('bork', { connected: false });
    expect(spec.target).toBe('leon');
    expect(send).toHaveBeenLastCalledWith('leon');
  });

  it('ends by itself when we’re revived, and isn’t offered while we’re up', () => {
    const { spec, set, send } = setup();
    spec.toggle();
    spec.cycle(1);
    expect(spec.target).toBe('leon');
    set('me', { dead: false });
    expect(spec.active).toBe(false);
    expect(spec.target).toBe('me');
    expect(send).toHaveBeenLastCalledWith(null);
    expect(spec.available).toBe(false);
    spec.toggle();
    expect(spec.active).toBe(false);
    // Down again: it starts over on the default, only when asked.
    set('me', { dead: true });
    expect(spec.active).toBe(false);
    spec.toggle();
    expect(spec.target).toBe('bork');
  });

  it('ends when everyone else is gone', () => {
    const { spec, set } = setup({ leon: { left: true }, cynthia: { left: true } });
    spec.toggle();
    expect(spec.target).toBe('bork');
    set('bork', { connected: false });
    expect(spec.active).toBe(false);
    expect(spec.available).toBe(false);
  });

  it('is never available in solo', () => {
    const spec = new Spectator('me', null);
    spec.update([{ id: 'me', index: 0, dead: true, connected: true, left: false }]);
    expect(spec.available).toBe(false);
    spec.toggle();
    expect(spec.active).toBe(false);
    // Even with others in the state (a solo connection never spectates).
    spec.update([
      { id: 'me', index: 0, dead: true, connected: true, left: false },
      { id: 'x', index: 1, dead: false, connected: true, left: false },
    ]);
    expect(spec.available).toBe(false);
  });

  it('tells the server again after a reconnect, only while spectating someone else', () => {
    const { spec, send, set } = setup();
    spec.resend();
    expect(send).not.toHaveBeenCalled();
    spec.toggle();
    send.mockClear();
    spec.resend();
    expect(send).toHaveBeenCalledWith('bork');
    // Repeated snapshots don't repeat the message.
    send.mockClear();
    set('leon', {});
    set('leon', {});
    expect(send).not.toHaveBeenCalled();
  });
});
