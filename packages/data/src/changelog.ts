// The changelog (`changelog.json`): what each release changed for players. The client shows it on
// the What's new screen and labels the build with its newest version; `pnpm release` turns the
// `unreleased` block into the next version and regenerates CHANGELOG.md from it.
import changelogJson from '../changelog.json' with { type: 'json' };
import { t } from './i18n.js';
import {
  CHANGELOG_SECTIONS,
  ChangelogFileSchema,
  hasEntries,
  type ChangelogEntries,
  type ChangelogFile,
  type ChangelogSection,
  type ChangelogVersion,
} from './schemas/index.js';
import { parseDataFile } from './util.js';

let changelog: ChangelogFile | undefined;

/** The bundled changelog, validated once. Throws if invalid. */
export function loadChangelog(): ChangelogFile {
  return (changelog ??= parseDataFile('changelog', ChangelogFileSchema, changelogJson));
}

/** The newest released version, or undefined before the first release. */
export function latestRelease(file: ChangelogFile): ChangelogVersion | undefined {
  return file.versions[0];
}

/**
 * The build's version as shown to players: `v7` for a release, `v7+dev` when there are unreleased
 * entries on top (dev builds, unreleased main), and `dev` before the first release.
 */
export function versionLabel(file: ChangelogFile): string {
  const latest = latestRelease(file);
  if (!latest) return 'dev';
  return hasEntries(file.unreleased.entries) ? `v${latest.version}+dev` : `v${latest.version}`;
}

/** The UI string key of each section's title. */
export const CHANGELOG_SECTION_TITLES = {
  new: 'changelog.new',
  changed: 'changelog.changed',
  fixed: 'changelog.fixed',
  behindTheScenes: 'changelog.behindTheScenes',
} as const satisfies Record<ChangelogSection, string>;

/** The sections of `entries` that have lines, in display order. */
export function changelogSections(
  entries: ChangelogEntries,
): { section: ChangelogSection; lines: readonly string[] }[] {
  return CHANGELOG_SECTIONS.flatMap((section) => {
    const lines = entries[section] ?? [];
    return lines.length ? [{ section, lines }] : [];
  });
}

/**
 * CHANGELOG.md, Keep a Changelog style: Unreleased, then each version newest first with its date,
 * its PRs (linked under `repoUrl`, e.g. `https://github.com/owner/repo`) and its sections.
 */
export function renderChangelogMarkdown(file: ChangelogFile, repoUrl: string): string {
  const prs = (list: readonly number[]) =>
    list.length ? [`PRs: ${list.map((n) => `[#${n}](${repoUrl}/pull/${n})`).join(', ')}`, ''] : [];
  const body = (entries: ChangelogEntries) =>
    changelogSections(entries).flatMap(({ section, lines }) => [
      `### ${t(CHANGELOG_SECTION_TITLES[section])}`,
      '',
      ...lines.map((line) => `- ${line}`),
      '',
    ]);
  const out = [
    '# Changelog',
    '',
    'What changed for players in each release, newest first. Generated from',
    '`packages/data/changelog.json` by `pnpm changelog`: edit the JSON, not this file. See',
    '[CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add entries.',
    '',
    '## Unreleased',
    '',
    ...prs(file.unreleased.prs),
    ...body(file.unreleased.entries),
  ];
  for (const v of file.versions) {
    out.push(`## v${v.version} - ${v.date}`, '', ...prs(v.prs), ...body(v.entries));
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export interface Release {
  /** The changelog after the release: `unreleased` emptied, the new version first. */
  file: ChangelogFile;
  version: ChangelogVersion;
}

/**
 * Turns `unreleased` into version N+1 dated `date` (`YYYY-MM-DD`), with its PRs (deduplicated,
 * sorted). Throws when there is nothing to release. Pure: the CLI writes the files and tags.
 */
export function releaseChangelog(file: ChangelogFile, date: string): Release {
  if (!hasEntries(file.unreleased.entries))
    throw new Error('Nothing to release: changelog.json has no unreleased entries.');
  const entries = Object.fromEntries(
    changelogSections(file.unreleased.entries).map(({ section, lines }) => [section, [...lines]]),
  ) as ChangelogEntries;
  const version: ChangelogVersion = {
    version: (latestRelease(file)?.version ?? 0) + 1,
    date,
    prs: [...new Set(file.unreleased.prs)].sort((a, b) => a - b),
    entries,
  };
  const next = ChangelogFileSchema.parse({
    // Empty lists rather than none, so the next PR sees where its lines go.
    unreleased: { prs: [], entries: Object.fromEntries(CHANGELOG_SECTIONS.map((k) => [k, []])) },
    versions: [version, ...file.versions],
  });
  return { file: next, version };
}
