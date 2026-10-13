// Who shows a room notice: the app shell's global toasts and notices, or the game. While a
// multiplayer game is on screen it gets the socket and shows them over the canvas itself (with its
// own connection and "server updating" notices), so the shell stays quiet for those.
import type { NoticeCode } from '@pokesurvivor/protocol';
import { GAME_NOTICES } from '../game/notices.js';

/** Does the shell toast this notice? */
export function shellShowsNotice(code: NoticeCode, gameOnScreen: boolean): boolean {
  return !gameOnScreen || !GAME_NOTICES.has(code);
}
