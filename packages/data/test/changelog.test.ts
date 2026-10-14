import { describe, expect, it } from 'vitest';
import {
  ChangelogFileSchema,
  loadChangelog,
  releaseChangelog,
  renderChangelogMarkdown,
  versionLabel,
  type ChangelogFile,
} from '../src/index.js';

const REPO = 'https://github.com/owner/repo';

const v1 = {
  version: 1,
  date: '2026-09-01',
  prs: [10],
  entries: { new: ['Rifts.'], behindTheScenes: ['Faster server.'] },
};
const v2 = { version: 2, date: '2026-09-20', prs: [12, 11], entries: { fixed: ['A crash.'] } };

function file(overrides: Partial<ChangelogFile> = {}): ChangelogFile {
  return {
    unreleased: { prs: [], entries: {} },
    versions: [],
    ...overrides,
  };
}

const errors = (data: unknown) =>
  ChangelogFileSchema.safeParse(data).error?.issues.map((i) => i.message) ?? [];

describe('changelog validation', () => {
  it('accepts the bundled changelog', () => {
    expect(() => loadChangelog()).not.toThrow();
  });

  it('accepts versions newest first, numbered without gaps', () => {
    expect(errors(file({ versions: [v2, v1] }))).toEqual([]);
  });

  it('rejects versions out of order or with gaps', () => {
    expect(errors(file({ versions: [v1, v2] })).join()).toMatch(/expected version 2/);
    expect(errors(file({ versions: [{ ...v2, version: 3 }, v1] })).join()).toMatch(
      /expected version 2/,
    );
  });

  it('rejects a newer version dated before an older one', () => {
    expect(errors(file({ versions: [{ ...v2, date: '2026-08-01' }, v1] })).join()).toMatch(
      /dated before v1/,
    );
  });

  it('rejects bad dates, PR numbers, sections and empty lines', () => {
    expect(errors(file({ versions: [{ ...v1, date: '2026-02-30' }] }))).not.toEqual([]);
    expect(errors(file({ versions: [{ ...v1, date: '1 Sept 2026' }] }))).not.toEqual([]);
    expect(errors(file({ versions: [{ ...v1, prs: [0] }] }))).not.toEqual([]);
    expect(errors({ ...file(), unreleased: { prs: [], entries: { added: ['x'] } } })).not.toEqual(
      [],
    );
    expect(errors({ ...file(), unreleased: { prs: [], entries: { new: [''] } } })).not.toEqual([]);
  });

  it('rejects a released version without any line', () => {
    expect(errors(file({ versions: [{ ...v1, entries: { new: [] } }] })).join()).toMatch(
      /at least one line/,
    );
  });
});

describe('versionLabel', () => {
  it('is "dev" before the first release', () => {
    expect(versionLabel(file())).toBe('dev');
    expect(versionLabel(file({ unreleased: { prs: [], entries: { new: ['x'] } } }))).toBe('dev');
  });

  it('is the newest version, with +dev when there are unreleased lines', () => {
    expect(versionLabel(file({ versions: [v2, v1] }))).toBe('v2');
    expect(
      versionLabel(file({ versions: [v2, v1], unreleased: { prs: [], entries: { fixed: [] } } })),
    ).toBe('v2');
    expect(
      versionLabel(file({ versions: [v2, v1], unreleased: { prs: [3], entries: { new: ['x'] } } })),
    ).toBe('v2+dev');
  });
});

describe('releaseChangelog', () => {
  const pending = { prs: [14, 13, 14], entries: { new: ['Shiny charms.'], changed: [] } };

  it('turns unreleased into version N+1 with the date and sorted PRs', () => {
    const { file: next, version } = releaseChangelog(
      file({ versions: [v2, v1], unreleased: pending }),
      '2026-10-14',
    );
    expect(version).toEqual({
      version: 3,
      date: '2026-10-14',
      prs: [13, 14],
      entries: { new: ['Shiny charms.'] },
    });
    expect(next.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(next.unreleased).toEqual({
      prs: [],
      entries: { new: [], changed: [], fixed: [], behindTheScenes: [] },
    });
    expect(ChangelogFileSchema.parse(next)).toEqual(next);
  });

  it('makes v1 from an empty history', () => {
    expect(releaseChangelog(file({ unreleased: pending }), '2026-10-14').version.version).toBe(1);
  });

  it('refuses when there is nothing to release', () => {
    expect(() => releaseChangelog(file({ versions: [v1] }), '2026-10-14')).toThrow(
      /Nothing to release/,
    );
    expect(() =>
      releaseChangelog(
        file({ unreleased: { prs: [5], entries: { new: [], fixed: [] } } }),
        '2026-10-14',
      ),
    ).toThrow(/Nothing to release/);
  });

  it("doesn't change its input", () => {
    const before = file({ versions: [v1], unreleased: pending });
    const copy = structuredClone(before);
    releaseChangelog(before, '2026-10-14');
    expect(before).toEqual(copy);
  });
});

describe('renderChangelogMarkdown', () => {
  it('renders Unreleased, then versions newest first, sections in order', () => {
    const md = renderChangelogMarkdown(
      file({ versions: [v2, v1], unreleased: { prs: [13], entries: { fixed: ['Lag.'] } } }),
      REPO,
    );
    expect(md).toContain(
      [
        '## Unreleased',
        '',
        `PRs: [#13](${REPO}/pull/13)`,
        '',
        '### Fixed',
        '',
        '- Lag.',
        '',
        '## v2 - 2026-09-20',
        '',
        `PRs: [#12](${REPO}/pull/12), [#11](${REPO}/pull/11)`,
        '',
        '### Fixed',
        '',
        '- A crash.',
        '',
        '## v1 - 2026-09-01',
        '',
        `PRs: [#10](${REPO}/pull/10)`,
        '',
        '### New',
        '',
        '- Rifts.',
        '',
        '### Behind the scenes',
        '',
        '- Faster server.',
        '',
      ].join('\n'),
    );
    expect(md.startsWith('# Changelog\n')).toBe(true);
    expect(md.endsWith('- Faster server.\n')).toBe(true);
  });

  it('renders an empty history', () => {
    const md = renderChangelogMarkdown(file(), REPO);
    expect(md.endsWith('## Unreleased\n')).toBe(true);
    expect(md).not.toContain('PRs:');
  });
});
