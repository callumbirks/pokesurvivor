import type { NoticeCode } from '@pokesurvivor/protocol';
import { describe, expect, it } from 'vitest';
import { GAME_NOTICES, NOTICE_TEXT } from '../game/notices.js';
import { shellShowsNotice } from './notices.js';

const ALL: NoticeCode[] = [
  'dropped-at-loading',
  'player-disconnected',
  'player-reconnected',
  'player-left',
  'player-removed',
  'owner-changed',
  'kicked',
  'game-cancelled',
  'server-draining',
];

describe('room notices: shell or game', () => {
  it('shows them all in the shell outside a game', () => {
    for (const code of ALL) expect(shellShowsNotice(code, false)).toBe(true);
  });

  it("leaves the ones the game shows to the game while it's on screen (no duplicates)", () => {
    for (const code of ALL) expect(shellShowsNotice(code, true)).toBe(!GAME_NOTICES.has(code));
    expect(shellShowsNotice('owner-changed', true)).toBe(false);
    expect(shellShowsNotice('server-draining', true)).toBe(false);
  });

  it('only hides notices the game really shows', () => {
    // From the socket: the game has a text for them. The rest come from the snapshots.
    for (const code of GAME_NOTICES)
      expect(
        NOTICE_TEXT[code] !== undefined ||
          ['player-disconnected', 'player-reconnected', 'player-left'].includes(code),
      ).toBe(true);
    // Today the game covers every notice; a new code would show in the shell until it does.
    expect(ALL.filter((c) => !GAME_NOTICES.has(c))).toEqual([]);
  });
});
