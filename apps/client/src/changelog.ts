// What's new: which released version this device has seen. The main menu's What's new button shows
// a dot while the newest release (bundled from changelog.json at build time) is newer; opening the
// screen marks it seen. Per device in localStorage, never synced: it's about this browser.
import { latestRelease, type ChangelogFile } from '@pokesurvivor/data';

export const CHANGELOG_SEEN_KEY = 'ps.changelog.seen';

type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): SeenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The newest version this device has seen; 0 if none (or unreadable). */
export function lastSeenVersion(storage: SeenStorage | null = browserStorage()): number {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(CHANGELOG_SEEN_KEY) ?? null;
  } catch {
    // Storage blocked: as if nothing was seen.
  }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Whether there's a release this device hasn't seen. Nothing stored counts as nothing seen, so a
 * new player sees the dot too (until they open the screen).
 */
export function hasUnseenRelease(
  file: ChangelogFile,
  storage: SeenStorage | null = browserStorage(),
): boolean {
  return (latestRelease(file)?.version ?? 0) > lastSeenVersion(storage);
}

/** Records the newest release as seen (called when the What's new screen opens). */
export function markChangelogSeen(
  file: ChangelogFile,
  storage: SeenStorage | null = browserStorage(),
): void {
  const latest = latestRelease(file)?.version;
  // Never go backwards (e.g. an older build opened after a newer one).
  if (!latest || latest <= lastSeenVersion(storage)) return;
  try {
    storage?.setItem(CHANGELOG_SEEN_KEY, String(latest));
  } catch {
    // Storage full or blocked: the dot comes back next time, nothing worse.
  }
}
