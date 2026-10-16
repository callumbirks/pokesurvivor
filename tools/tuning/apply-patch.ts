// Bakes live-tuning overrides into the repo's data files: the "Export as patch" file from the
// admin page (`#admin`) is merged into packages/data/json/tuning.json and levelup.json.
//   pnpm --filter @pokesurvivor/tools apply-tuning-patch <patch.json> [--dry-run]
// (the path is relative to where you run it)
// Only the changed values are rewritten in place (the rest of each file, its layout included, is
// left alone), then the file is formatted as `pnpm format` would. The result is validated with
// the same schemas the server uses. Deploy it, then revert the live config to the defaults.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isJsonObject,
  loadGameData,
  mergePatch,
  patchLeaves,
  TUNABLE_FILES,
  validateTunables,
  type TunableFile,
} from '@pokesurvivor/data';
import { format, resolveConfig } from 'prettier';
import { valueSpans } from './spans.js';

const root = resolve(import.meta.dirname, '../..');
const pathOf = (file: TunableFile) => join(root, 'packages/data/json', `${file}.json`);

/** Rewrites the values `patch` changes in `text` (a JSON file), keeping everything else. */
export function applyPatchText(text: string, patch: unknown): string {
  const spans = valueSpans(text);
  const edits: { start: number; end: number; value: unknown }[] = [];
  for (const [path, value] of patchLeaves(patch)) {
    const span = spans.get(path.join('\0'));
    // A setting the file doesn't have yet (an optional one): rewrite the whole file instead.
    if (!span) return `${JSON.stringify(mergePatch(JSON.parse(text), patch), null, 2)}\n`;
    edits.push({ ...span, value });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + JSON.stringify(e.value) + out.slice(e.end);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: apply-tuning-patch <patch.json> [--dry-run]');
  const raw = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')) as unknown;
  // The admin page's export, or bare overrides (`{ tuning?, levelup? }`).
  const overrides = isJsonObject(raw) && 'overrides' in raw ? raw.overrides : raw;
  if (!isJsonObject(overrides)) throw new Error('the patch has no overrides');
  for (const key of Object.keys(overrides))
    if (!(TUNABLE_FILES as readonly string[]).includes(key))
      throw new Error(`"${key}" is not a tunable file (${TUNABLE_FILES.join(', ')})`);

  const texts = {} as Record<TunableFile, string>;
  const values = {} as Record<TunableFile, unknown>;
  for (const f of TUNABLE_FILES) {
    const before = readFileSync(pathOf(f), 'utf8');
    const patch = overrides[f];
    texts[f] = patch === undefined ? before : applyPatchText(before, patch);
    values[f] = JSON.parse(texts[f]) as unknown;
  }
  const valid = validateTunables(loadGameData(), values);
  if (!valid.ok) {
    for (const i of valid.issues) console.error(`  ${i.file}.json ${i.path}: ${i.message}`);
    throw new Error('the patched files are not valid; nothing was written');
  }
  for (const f of TUNABLE_FILES) {
    if (overrides[f] === undefined) continue;
    const path = pathOf(f);
    const out = await format(texts[f], { ...(await resolveConfig(path)), filepath: path });
    for (const [p, v] of patchLeaves(overrides[f]))
      console.log(`${f}.json ${p.join('.')} = ${JSON.stringify(v)}`);
    if (!dryRun) writeFileSync(path, out);
  }
  console.log(
    dryRun
      ? 'Dry run: nothing written.'
      : 'Done. Commit, deploy, then revert the live config to the defaults.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
