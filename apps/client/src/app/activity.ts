// What a friend is doing, as the Friends list and the room's invite list show it: "Main Menu",
// "In a room", "Solo • Pikachu • 3:35" or "Multiplayer • Pikachu • 3:35". A run's clock ticks
// on locally from the last presence message (`NetClient.activities`); the server only re-sends
// it when the run pauses, resumes or drifts.
import { loadGameData, t } from '@pokesurvivor/data';
import type { FriendActivity, PresenceStatus } from '@pokesurvivor/protocol';

export interface ActivityEntry {
  activity: FriendActivity;
  /** When it arrived (ms, the clock `now` is on). */
  at: number;
}

/** Run time as `m:ss`, or `h:mm:ss` from an hour. */
export function formatRunTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** The run's time now: `elapsedS` at `at`, moved on unless paused. */
export function runClock(entry: ActivityEntry, now: number): number {
  const a = entry.activity;
  if (a.kind === 'menu') return 0;
  return a.paused ? a.elapsedS : a.elapsedS + Math.max(0, now - entry.at) / 1000;
}

const statusLabel = (p: PresenceStatus): string =>
  ({
    offline: t('friends.offline'),
    online: t('friends.online'),
    in_lobby: t('app.inALobby'),
    in_game: t('friends.playing'),
  })[p];

/**
 * The line under a friend's name. Offline stays "Offline"; in a room's lobby "In a room" (it
 * matters to whoever wants to invite them); without an activity (an older server) the plain
 * status.
 */
export function activityLabel(
  status: PresenceStatus,
  entry: ActivityEntry | undefined,
  now: number,
): string {
  if (status === 'offline' || status === 'in_lobby' || !entry) return statusLabel(status);
  const a = entry.activity;
  if (a.kind === 'menu') return t('friends.mainMenu');
  const name =
    (loadGameData().pokemonByDex.get(a.dex)?.name ?? `#${a.dex}`) +
    (a.prestige ? ` ${'★'.repeat(a.prestige)}` : '');
  const time = formatRunTime(runClock(entry, now));
  return t(a.kind === 'solo' ? 'friends.activitySolo' : 'friends.activityCoop', {
    0: name,
    1: time,
  });
}

/** The Pokémon a friend is playing right now, if they're in a run. */
export function activityPokemon(
  entry: ActivityEntry | undefined,
): { dex: number; shiny: boolean; prestige?: number } | null {
  const a = entry?.activity;
  return a && a.kind !== 'menu' ? { dex: a.dex, shiny: a.shiny, prestige: a.prestige } : null;
}
