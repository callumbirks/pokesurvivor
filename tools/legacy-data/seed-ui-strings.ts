// One-off: seeds packages/data/i18n/en.json from the UI strings in legacy lang-en.js, grouped by
// screen (the file's section comments). Entries already used for game data (see convert.ts), the
// original author's donation and Firebase/Google texts, and sentence fragments the legacy DOM
// translator stitched together are left out. Legacy `{x}` holes become `{0}`, `{1}`…
//
//   pnpm --filter @pokesurvivor/tools seed-ui-strings [--force]
//
// en.json is hand-maintained after seeding, so this refuses to overwrite it without --force.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { loadLegacy, repoRoot } from './legacy.js';

const out = resolve(repoRoot, 'packages/data/i18n/en.json');
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} exists and is maintained by hand; pass --force to overwrite it.`);
  process.exit(1);
}

const { dictionary } = loadLegacy();
const source = readFileSync(resolve(repoRoot, 'legacy/js/data/lang-en.js'), 'utf8');
const dataKeys = new Set<string>(
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'data-dictionary-keys.json'), 'utf8'),
  ) as string[],
);

/** lang-en.js section comment → en.json group (`null` = not UI text). */
const SECTIONS: [heading: string, group: string | null][] = [
  ['tipos y regiones', null],
  ['movimientos', null],
  ['descripciones de los movimientos', null],
  ['mejoras de los movimientos', null],
  ['cartas al subir de nivel', 'levelUp'],
  ['objetos', 'items'],
  ['mejoras permanentes', 'upgrades'],
  ['interactivos y clima', 'hud'],
  ['biomas y arenas', 'hud'],
  ['avisos durante la partida', 'hud'],
  ['pausa y fin', 'pause'],
  ['inicio de sesión y test', 'login'],
  ['test de personalidad', null],
  ['menú', 'menu'],
  ['colección', 'collection'],
  ['gacha', 'gacha'],
  ['mejoras', 'upgrades'],
  ['misiones, logros y perfil', 'profile'],
  // Mission and achievement texts are game data; what's left here is stale.
  ['misiones', null],
  ['logros', null],
  ['amigos, sala e invitaciones', 'friends'],
  ['ranking', 'leaderboard'],
  ['ajustes', 'settings'],
  ['aviso legal', 'legal'],
  ['donaciones', null],
  ['2026-10-10: grietas, jefes, pantalla de inicio, movimientos nuevos', 'hud'],
  ['eventos y duendes (2026-10-10)', 'hud'],
];
const sectionStarts: { at: number; group: string | null }[] = [];
for (const [heading, group] of SECTIONS) {
  const re = new RegExp(
    `^\\s*// (?:-+ )?${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: -+)?\\s*$`,
    'm',
  );
  const m = re.exec(source);
  if (!m) throw new Error(`lang-en.js section not found: ${heading}`);
  sectionStarts.push({ at: m.index, group });
}
sectionStarts.sort((a, b) => a.at - b.at);

function groupOf(spanish: string): string | null {
  const literals = [
    `'${spanish.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`,
    JSON.stringify(spanish),
  ];
  const at = Math.min(...literals.map((l) => source.indexOf(l)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) throw new Error(`can't find ${spanish} in lang-en.js`);
  let group: string | null = null;
  for (const s of sectionStarts) if (s.at < at) group = s.group;
  return group;
}

const LEGACY_ONLY =
  /firebase|firestore|google|ko-fi|donat|cryptocurrenc|pokesurvivor\.com|incognito|from a file/i;
/** Pieces of longer sentences (the legacy translator matched DOM text nodes). */
const FRAGMENT = /^[·:,.(]|[·:,(]$|^\.\s|^[a-z]/;
const FRAGMENTS = new Set([
  'Sprites from',
  'Friends and leaderboard: your',
  'Group games: your browser connects',
]);

function keyFor(english: string): string {
  const words = english
    .replace(/\{x\}/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[×]/g, 'x')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const key = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  // Keys should also work as identifiers.
  return /^[0-9]/.test(key) ? `n${key}` : key || 'text';
}

const groups: Record<string, Record<string, string>> = {};
const seen = new Set<string>();
for (const [spanish, english] of Object.entries(dictionary)) {
  if (dataKeys.has(spanish)) continue;
  const group = groupOf(spanish);
  if (!group) continue;
  if (LEGACY_ONLY.test(spanish) || LEGACY_ONLY.test(english)) continue;
  if (FRAGMENT.test(english.trim()) || FRAGMENT.test(spanish.trim()) || FRAGMENTS.has(english))
    continue;
  let n = 0;
  const text = english.replace(/\{x\}/g, () => `{${n++}}`);
  // The same English text once per group is enough.
  if (seen.has(`${group}\0${text}`)) continue;
  seen.add(`${group}\0${text}`);
  const entries = (groups[group] ??= {});
  const base = keyFor(english);
  let key = base;
  for (let i = 2; key in entries; i++) key = `${base}${i}`;
  entries[key] = text;
}

writeFileSync(
  out,
  await format(JSON.stringify(groups), { ...(await resolveConfig(out)), parser: 'json' }),
);
const total = Object.values(groups).reduce((sum, g) => sum + Object.keys(g).length, 0);
console.log(`wrote ${total} UI strings in ${Object.keys(groups).length} groups to ${out}`);
