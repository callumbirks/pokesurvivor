// Room notices the game shows itself, in its own toasts over the canvas. The app shell doesn't
// toast these while a multiplayer game is on screen, so there's one of each.
import type { UiStringKey } from '@pokesurvivor/data';
import type { NoticeCode } from '@pokesurvivor/protocol';

/** From the socket (`MountGameOptions.client`): the notice's text. */
export const NOTICE_TEXT: Partial<Record<NoticeCode, UiStringKey>> = {
  'owner-changed': 'game.noticeOwnerChanged',
  'server-draining': 'game.noticeDraining',
  'game-cancelled': 'game.noticeCancelled',
  kicked: 'game.noticeKicked',
  'player-removed': 'game.noticeRemoved',
  'dropped-at-loading': 'game.noticeDropped',
};

/** Every notice the game shows: the ones above, and teammates leaving, dropping and coming back
 * (from the snapshots). */
export const GAME_NOTICES: ReadonlySet<NoticeCode> = new Set<NoticeCode>([
  ...(Object.keys(NOTICE_TEXT) as NoticeCode[]),
  'player-disconnected',
  'player-reconnected',
  'player-left',
]);
