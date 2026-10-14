// @vitest-environment happy-dom
import type { ChangelogFile } from '@pokesurvivor/data';
import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_SEEN_KEY,
  hasUnseenRelease,
  lastSeenVersion,
  markChangelogSeen,
} from './changelog.js';
import { changelogDate, renderChangelog } from './screens/changelog.js';

function memory(initial?: string) {
  const data = new Map<string, string>(
    initial === undefined ? [] : [[CHANGELOG_SEEN_KEY, initial]],
  );
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const release = (version: number, date: string) => ({
  version,
  date,
  prs: [version * 10],
  entries: { new: [`Feature ${version}.`] },
});

const empty: ChangelogFile = { unreleased: { prs: [], entries: {} }, versions: [] };
const v2: ChangelogFile = {
  unreleased: { prs: [], entries: {} },
  versions: [
    {
      version: 2,
      date: '2026-10-14',
      prs: [40],
      entries: {
        new: ['Rifts.'],
        changed: ['Faster bosses.'],
        fixed: ['A crash.'],
        behindTheScenes: ['New servers.'],
      },
    },
    release(1, '2026-09-01'),
  ],
};

describe("the What's new dot", () => {
  it('shows for a new player with nothing stored', () => {
    expect(lastSeenVersion(memory())).toBe(0);
    expect(hasUnseenRelease(v2, memory())).toBe(true);
  });

  it('shows while the newest release is newer than the last seen one', () => {
    expect(hasUnseenRelease(v2, memory('1'))).toBe(true);
    expect(hasUnseenRelease(v2, memory('2'))).toBe(false);
    expect(hasUnseenRelease(v2, memory('3'))).toBe(false);
  });

  it("doesn't show before the first release", () => {
    expect(hasUnseenRelease(empty, memory())).toBe(false);
  });

  it('treats garbage as nothing seen', () => {
    for (const bad of ['', 'v2', '-1', '1.5', 'NaN']) expect(lastSeenVersion(memory(bad))).toBe(0);
    expect(lastSeenVersion(null)).toBe(0);
  });

  it('goes away once the screen marks the release seen', () => {
    const storage = memory('1');
    markChangelogSeen(v2, storage);
    expect(storage.data.get(CHANGELOG_SEEN_KEY)).toBe('2');
    expect(hasUnseenRelease(v2, storage)).toBe(false);
  });

  it('never moves the last seen version backwards, and stores nothing without releases', () => {
    const newer = memory('5');
    markChangelogSeen(v2, newer);
    expect(newer.data.get(CHANGELOG_SEEN_KEY)).toBe('5');
    const none = memory();
    markChangelogSeen(empty, none);
    expect(none.data.size).toBe(0);
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(hasUnseenRelease(v2, broken)).toBe(true);
    expect(() => markChangelogSeen(v2, broken)).not.toThrow();
  });
});

describe("the What's new screen", () => {
  it('lists releases newest first with dates and sections in order', () => {
    const el = renderChangelog(v2);
    const versions = [...el.querySelectorAll('.cl-ver')];
    expect(versions.map((v) => v.getAttribute('data-testid'))).toEqual(['cl-v2', 'cl-v1']);
    expect(versions[0]?.querySelector('h3')?.textContent).toBe('Version 2');
    expect(versions[0]?.querySelector('time')?.textContent).toBe('14 Oct 2026');
    expect([...(versions[0]?.querySelectorAll('.cl-h') ?? [])].map((h) => h.textContent)).toEqual([
      'New',
      'Changed',
      'Fixed',
    ]);
  });

  it('folds "Behind the scenes" away', () => {
    const bts = renderChangelog(v2).querySelector('details.cl-bts');
    expect(bts?.querySelector('summary')?.textContent).toBe('Behind the scenes');
    expect(bts?.hasAttribute('open')).toBe(false);
    // Reachable by the gamepad's menu navigation, which only visits focusable elements.
    expect(bts?.querySelector('summary')?.getAttribute('tabindex')).toBe('0');
    expect(bts?.textContent).toContain('New servers.');
  });

  it('shows an empty state before the first release', () => {
    const el = renderChangelog({ ...empty, unreleased: { prs: [1], entries: { new: ['Soon.'] } } });
    expect(el.querySelector('[data-testid="cl-empty"]')).not.toBeNull();
    expect(el.querySelector('.cl-ver')).toBeNull();
  });

  it('shows unreleased lines only when asked (dev builds)', () => {
    const file = { ...v2, unreleased: { prs: [1], entries: { fixed: ['Soon.'] } } };
    expect(renderChangelog(file).querySelector('[data-testid="cl-unreleased"]')).toBeNull();
    const dev = renderChangelog(file, { unreleased: true });
    expect(dev.querySelector('.cl-ver')?.getAttribute('data-testid')).toBe('cl-unreleased');
    expect(dev.querySelector('[data-testid="cl-empty"]')).toBeNull();
  });

  it('formats calendar dates without a time zone shift', () => {
    expect(changelogDate('2026-01-01')).toBe('1 Jan 2026');
  });
});
