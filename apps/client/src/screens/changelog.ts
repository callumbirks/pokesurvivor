// What's new: the changelog bundled from packages/data/changelog.json, newest release first, each
// with its date and its lines grouped New / Changed / Fixed, and "Behind the scenes" folded away.
// Opening it marks the newest release as seen (the menu button's dot goes away).
import {
  CHANGELOG_SECTION_TITLES,
  changelogSections,
  loadChangelog,
  t,
  type ChangelogEntries,
  type ChangelogFile,
} from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { h } from '../app/dom.js';
import { markChangelogSeen } from '../changelog.js';
import { screenBox } from './common.js';

/** `2026-10-14` → "14 Oct 2026" (the date is a calendar day: no time zone shift). */
export function changelogDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function sections(entries: ChangelogEntries): Node[] {
  return changelogSections(entries).map(({ section, lines }) => {
    const title = t(CHANGELOG_SECTION_TITLES[section]);
    const list = h(
      'ul',
      { class: 'cl-lines' },
      lines.map((line) => h('li', null, line)),
    );
    // Behind the scenes: collapsed and muted, for the curious.
    return section === 'behindTheScenes'
      ? h(
          'details',
          { class: 'cl-sec cl-bts', dataset: { testid: 'cl-bts' } },
          // Focusable, so the gamepad's menu navigation (menu-nav.ts) can reach and open it.
          h('summary', { tabindex: 0 }, title),
          list,
        )
      : h('div', { class: ['cl-sec', `cl-${section}`] }, h('h4', { class: 'cl-h' }, title), list);
  });
}

/**
 * The list of releases, newest first. `unreleased`: also show the unreleased lines on top (dev
 * builds), which otherwise only appear once released.
 */
export function renderChangelog(file: ChangelogFile, opts: { unreleased?: boolean } = {}) {
  const pending = opts.unreleased ? sections(file.unreleased.entries) : [];
  return h(
    'div',
    { class: 'cl-list' },
    pending.length
      ? h(
          'article',
          { class: 'cl-ver cl-dev', tabindex: 0, dataset: { testid: 'cl-unreleased' } },
          h('div', { class: 'cl-ver-head' }, h('h3', null, t('changelog.unreleased'))),
          pending,
        )
      : null,
    file.versions.length === 0
      ? h(
          'p',
          { class: 'muted cl-empty', dataset: { testid: 'cl-empty' } },
          t('changelog.noReleasesYet'),
        )
      : file.versions.map((v) =>
          h(
            'article',
            // Focusable: the gamepad scrolls the list by moving through the releases.
            { class: 'cl-ver', tabindex: 0, dataset: { testid: `cl-v${v.version}` } },
            h(
              'div',
              { class: 'cl-ver-head' },
              h('h3', null, t('changelog.version', { 0: v.version })),
              h('time', { class: 'muted', datetime: v.date }, changelogDate(v.date)),
            ),
            sections(v.entries),
          ),
        ),
  );
}

export function changelogScreen(app: App): Screen {
  const file = loadChangelog();
  const box = screenBox(app, { id: 'changelog', title: t('changelog.whatsNew'), wide: false });
  box.el.querySelector('.box')?.classList.add('changelog');
  box.body.append(renderChangelog(file, { unreleased: import.meta.env.DEV }));
  markChangelogSeen(file);
  return { el: box.el };
}
