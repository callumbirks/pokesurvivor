// @vitest-environment happy-dom
import type { SimEvent } from '@pokesurvivor/sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from './frame.js';
import { MATE_DOWN_SFX_GAP, MateAlerts, MateBanner } from './mate-alerts.js';

type Player = Frame['players'][number];

function frame(selfId = 'me', down: string[] = []): Pick<Frame, 'selfId' | 'players' | 'game'> {
  const ids = ['me', 'bork', 'leon'];
  return {
    selfId,
    players: ids.map(
      (id) => ({ id, dead: down.includes(id), left: false, connected: true }) as Player,
    ),
    game: {
      players: [
        { id: 'me', username: 'ash', dex: 4 },
        { id: 'bork', username: 'bork', dex: 25 },
        { id: 'leon', username: 'leon', dex: 7 },
      ],
    } as Frame['game'],
  };
}

function setup() {
  let now = 1000;
  const banner = vi.fn<(text: string, hint: string | null) => void>();
  const toast = vi.fn<(text: string) => void>();
  const sfx = vi.fn<(name: string) => void>();
  const names: Record<number, string> = { 4: 'Charmander', 25: 'Pikachu', 7: 'Squirtle' };
  const alerts = new MateAlerts({
    banner,
    toast,
    sfx,
    now: () => now,
    pokemonName: (dex) => names[dex] ?? `#${dex}`,
  });
  return { alerts, banner, toast, sfx, advance: (ms: number) => (now += ms) };
}

const down = (playerId: string): SimEvent => ({ type: 'player-down', playerId });
const revived = (playerId: string, by: string | null = 'me'): SimEvent => ({
  type: 'player-revived',
  playerId,
  by,
});

describe('MateAlerts', () => {
  it("shows a teammate's going down, with the sound and a hint to revive them", () => {
    const { alerts, banner, sfx } = setup();
    alerts.play([down('bork')], frame('me', ['bork']));
    expect(banner).toHaveBeenCalledWith("bork's Pikachu is down!", 'Go revive them!');
    expect(sfx).toHaveBeenCalledWith('mateDown');
  });

  it('leaves our own going down alone', () => {
    const { alerts, banner, sfx, toast } = setup();
    alerts.play([down('me')], frame('me', ['me']));
    expect(banner).not.toHaveBeenCalled();
    expect(sfx).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows our own revive as a banner naming who revived us', () => {
    const { alerts, banner, toast } = setup();
    alerts.play([revived('me', 'bork')], frame('me'));
    expect(banner).toHaveBeenCalledWith("You're back up!", 'Revived by bork', true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows our own revive without a name when nobody did it (a rift exit)', () => {
    const { alerts, banner } = setup();
    alerts.play([revived('me', null)], frame('me'));
    expect(banner).toHaveBeenCalledWith("You're back up!", null, true);
  });

  it('drops the hint when nobody is up to revive them', () => {
    const { alerts, banner } = setup();
    alerts.play([down('bork')], frame('me', ['me', 'bork', 'leon']));
    expect(banner).toHaveBeenCalledWith("bork's Pikachu is down!", null);
  });

  it("notes a teammate's revive", () => {
    const { alerts, toast, banner } = setup();
    alerts.play([revived('bork')], frame('me'));
    expect(toast).toHaveBeenCalledWith("bork's Pikachu is back!");
    expect(banner).not.toHaveBeenCalled();
  });

  it('plays the sound once when several go down at once, and again later', () => {
    const { alerts, banner, sfx, advance } = setup();
    alerts.play([down('bork'), down('leon')], frame('me', ['bork', 'leon']));
    expect(banner).toHaveBeenCalledTimes(2);
    expect(banner).toHaveBeenLastCalledWith("leon's Squirtle is down!", 'Go revive them!');
    expect(sfx).toHaveBeenCalledTimes(1);
    advance(MATE_DOWN_SFX_GAP / 2);
    alerts.play([down('bork')], frame('me', ['bork']));
    expect(sfx).toHaveBeenCalledTimes(1);
    advance(MATE_DOWN_SFX_GAP);
    alerts.play([down('bork')], frame('me', ['bork']));
    expect(sfx).toHaveBeenCalledTimes(2);
  });

  it('ignores players not in the game and other events', () => {
    const { alerts, banner, sfx, toast } = setup();
    alerts.play([down('ghost'), { type: 'level-up' } as SimEvent], frame());
    expect(banner).not.toHaveBeenCalled();
    expect(sfx).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('MateBanner', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the text and hint, then hides itself', () => {
    vi.useFakeTimers();
    const parent = document.createElement('div');
    const b = new MateBanner(parent);
    expect(b.root.hidden).toBe(true);
    b.show("bork's Pikachu is down!", 'Go revive them!', 2.5);
    expect(b.root.hidden).toBe(false);
    expect(b.root.textContent).toBe("bork's Pikachu is down!Go revive them!");
    vi.advanceTimersByTime(2500);
    expect(b.root.classList.contains('out')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(b.root.hidden).toBe(true);
    expect(b.root.classList.contains('self')).toBe(false);
    b.show("You're back up!", null, 2.5, true);
    expect(b.root.classList.contains('self')).toBe(true);
    b.show("bork's Pikachu is down!", null);
    expect(b.root.classList.contains('self')).toBe(false);
    b.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
