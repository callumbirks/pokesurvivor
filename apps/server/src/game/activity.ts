// What online friends are doing (`FriendActivity` in presence messages): the menus, a solo run or
// a coop game, with the Pokémon and a run clock that clients tick on locally. The server only
// re-sends it when something a friend would see changes: the kind, the Pokémon, a pause, or the
// clock drifting from what the friend's client is counting.
import type { FriendActivity, PresenceStatus } from '@pokesurvivor/protocol';

/** A friend's client is corrected once its clock is off by more than this. */
export const MAX_CLOCK_DRIFT_S = 2;
/**
 * A solo run the client stopped reporting is dropped from presence after this long (the client
 * reports at least at every server checkpoint, every 3 minutes of wall-clock time at the most).
 */
export const SOLO_STALE_MS = 5 * 60_000;

/** A solo run as its client last reported it (`activity` message), checked against the database. */
export interface SoloActivity {
  runId: string;
  dex: number;
  shiny: boolean;
  /** The Pokémon's prestige stars (0: none). */
  prestige: number;
  /** The run's start (ms): the run time can't be more than the wall-clock time since. */
  startedAt: number;
  elapsedS: number;
  paused: boolean;
  /** When it was reported (ms). */
  at: number;
}

/** The run time `elapsedS` at `at` (ms) has reached by `now`. */
export function clockAt(
  a: { elapsedS: number; paused?: boolean | undefined },
  at: number,
  now: number,
): number {
  return a.paused ? a.elapsedS : a.elapsedS + Math.max(0, now - at) / 1000;
}

export function soloActivity(solo: SoloActivity, now: number): FriendActivity {
  // Display only, but bounded: never past the wall-clock time since the run started.
  const max = Math.max(0, (now - solo.startedAt) / 1000);
  const elapsedS = Math.min(max, clockAt(solo, solo.at, now));
  return run('solo', solo.dex, solo.shiny, elapsedS, solo.paused, solo.prestige);
}

export function run(
  kind: 'solo' | 'coop',
  dex: number,
  shiny: boolean,
  elapsedS: number,
  paused: boolean,
  prestige = 0,
): FriendActivity {
  return {
    kind,
    dex,
    shiny,
    elapsedS: Math.round(elapsedS * 10) / 10,
    ...(paused ? { paused: true as const } : {}),
    ...(prestige ? { prestige } : {}),
  };
}

/** What a user's friends were last sent. */
export interface SentPresence {
  status: PresenceStatus;
  activity: FriendActivity | undefined;
  at: number;
}

/** Does `next` (now) differ from what friends were sent in a way they would see? */
export function presenceDiffers(
  sent: SentPresence | undefined,
  status: PresenceStatus,
  next: FriendActivity | undefined,
  now: number,
): boolean {
  if (!sent) return status !== 'offline';
  if (sent.status !== status) return true;
  const prev = sent.activity;
  if (!prev || !next) return prev !== next;
  if (prev.kind !== next.kind) return true;
  if (prev.kind === 'menu' || next.kind === 'menu') return false;
  if (prev.dex !== next.dex || prev.shiny !== next.shiny || !!prev.paused !== !!next.paused)
    return true;
  return Math.abs(clockAt(prev, sent.at, now) - next.elapsedS) > MAX_CLOCK_DRIFT_S;
}
