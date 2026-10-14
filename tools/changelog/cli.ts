// The changelog's command line (the logic is in @pokesurvivor/data, `src/changelog.ts`):
//   pnpm changelog              regenerate CHANGELOG.md from packages/data/changelog.json
//   pnpm changelog:check        fail if CHANGELOG.md is out of date (part of `pnpm lint`)
//   pnpm release [--dry-run]    unreleased → version N+1 dated today, regenerate CHANGELOG.md,
//                               commit and tag vN (no push). See docs/deploy.md.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ChangelogFileSchema,
  parseDataFile,
  releaseChangelog,
  renderChangelogMarkdown,
  type ChangelogFile,
} from '@pokesurvivor/data';
import { format, resolveConfig } from 'prettier';

const REPO_URL = 'https://github.com/callumbirks/pokesurvivor';
const root = resolve(import.meta.dirname, '../..');
const JSON_PATH = join(root, 'packages/data/changelog.json');
const MD_PATH = join(root, 'CHANGELOG.md');

function readChangelog(): ChangelogFile {
  return parseDataFile(
    'changelog',
    ChangelogFileSchema,
    JSON.parse(readFileSync(JSON_PATH, 'utf8')) as unknown,
  );
}

/** Formats like `pnpm format` would, so `pnpm lint` accepts the generated files. */
async function pretty(text: string, filepath: string): Promise<string> {
  return format(text, { ...(await resolveConfig(filepath)), filepath });
}

const markdown = (file: ChangelogFile) => pretty(renderChangelogMarkdown(file, REPO_URL), MD_PATH);

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();

/** Today in local time, `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function render() {
  writeFileSync(MD_PATH, await markdown(readChangelog()));
  console.log('Wrote CHANGELOG.md');
}

async function check() {
  let current = '';
  try {
    current = readFileSync(MD_PATH, 'utf8');
  } catch {
    // Missing: reported below like any other difference.
  }
  if (current !== (await markdown(readChangelog()))) {
    console.error(
      'CHANGELOG.md is out of date with packages/data/changelog.json: run `pnpm changelog`.',
    );
    process.exit(1);
  }
}

async function release(dryRun: boolean) {
  const problems: string[] = [];
  const dirty = git('status', '--porcelain');
  if (dirty) problems.push(`The working tree has uncommitted changes:\n${dirty}`);

  const { file, version } = releaseChangelog(readChangelog(), today());
  const tag = `v${version.version}`;
  if (git('tag', '--list', tag)) problems.push(`The tag ${tag} already exists.`);

  const lines = Object.values(version.entries).flat().length;
  console.log(
    `${dryRun ? 'Would release' : 'Releasing'} ${tag} (${version.date}): ${lines} line(s), PRs ${
      version.prs.map((n) => `#${n}`).join(', ') || 'none'
    }.`,
  );
  if (problems.length) {
    console.error(dryRun ? '\nWithout --dry-run this would stop here:' : 'Not released:');
    for (const p of problems) console.error(p);
    if (!dryRun) process.exit(1);
  }
  const json = await pretty(JSON.stringify(file, null, 2), JSON_PATH);
  const md = await markdown(file);
  if (dryRun) {
    console.log(`\nWould update packages/data/changelog.json and CHANGELOG.md:\n`);
    console.log(md.slice(md.indexOf('## Unreleased')).split(`\n## v${version.version - 1} `)[0]);
    console.log(`Would commit "Release ${tag}" and tag ${tag}. Nothing was changed.`);
    return;
  }
  writeFileSync(JSON_PATH, json);
  writeFileSync(MD_PATH, md);
  git('add', JSON_PATH, MD_PATH);
  git('commit', '-m', `Release ${tag}`);
  git('tag', '-a', tag, '-m', `Release ${tag}`);
  console.log(`Committed and tagged ${tag}. Push it with: git push --follow-tags`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'render') await render();
  else if (command === 'check') await check();
  else if (command === 'release') await release(args.includes('--dry-run'));
  else throw new Error(`Usage: cli.ts render | check | release [--dry-run]`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
