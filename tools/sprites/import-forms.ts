// Fetch the alternate forms in packages/data/json/megas.json (Mega, Primal, Crowned) from
// SpriteCollab into assets/pokemon/{dex}-{kind}/ and record their geometry in
// assets/sprite-metadata.json. Then run `generate-sprites`.
//
//   pnpm --filter @pokesurvivor/tools import-forms            every form
//   pnpm --filter @pokesurvivor/tools import-forms 6 384      only these dexes
//
// Each animation we use (sprite.ts ANIMATIONS) is taken from the form's AnimData.xml, following
// `CopyOf`; one the form doesn't have is left out (the client falls back, see its sprites.ts).
// The ground anchor is the white pixel of the first frame of `{Anim}-Shadow.png`, minus half a
// pixel (how the base sheets' anchors were made). Shiny sheets come from `{form}/0001` when
// SpriteCollab's tracker marks them done; otherwise the form has none and the client draws the
// regular colours with the shiny sparkle. It also prints the forms' artists for CREDITS.md.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { ANIMATIONS, MegasFileSchema, type AnimationName } from '@pokesurvivor/data/schemas';

const REPO = 'https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master';
const root = resolve(import.meta.dirname, '../..');
const metadataFile = join(root, 'assets/sprite-metadata.json');

interface Geometry {
  width: number;
  height: number;
  frames: number;
  rows: number;
  durations: number[];
  anchorX: number;
  anchorY: number;
}
interface MetadataEntry {
  dex: number;
  form?: string;
  shadowSize: number;
  hovers: boolean;
  shiny: boolean;
  animations: Partial<Record<AnimationName, Geometry>>;
  shinyAnimations?: Partial<Record<AnimationName, Geometry>>;
}
interface TrackerNode {
  name: string;
  sprite_complete: number;
  sprite_credit: { primary: string; secondary: string[] };
  subgroups: Record<string, TrackerNode>;
}

async function get(path: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${REPO}/${path}`);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 404 || attempt >= 3) throw new Error(`${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** AnimData.xml: the shadow size and, per animation, its frame size, durations and `CopyOf`. */
function parseAnimData(xml: string) {
  const shadowSize = Number(/<ShadowSize>(\d+)<\/ShadowSize>/.exec(xml)?.[1] ?? 1);
  const anims = new Map<string, { w: number; h: number; d: number[]; copyOf?: string }>();
  for (const [, body] of xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)) {
    const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body!)?.[1];
    const name = tag('Name')!;
    const copyOf = tag('CopyOf');
    const d = [...body!.matchAll(/<Duration>(\d+)<\/Duration>/g)].map((m) => Number(m[1]));
    anims.set(name, { w: Number(tag('FrameWidth')), h: Number(tag('FrameHeight')), d, copyOf });
  }
  return { shadowSize, anims };
}

/** The anchor from a shadow sheet: its white pixel in the first frame of the first row. */
function anchorOf(shadow: Buffer, w: number, h: number): { anchorX: number; anchorY: number } {
  const png = PNG.sync.read(shadow);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b, a] = [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
      if (a === 255 && r === 255 && g === 255 && b === 255)
        return { anchorX: x - 0.5, anchorY: y - 0.5 };
    }
  throw new Error('shadow sheet without an anchor pixel');
}

/** Downloads a form's (or its shiny's) sheets into `dir`; returns their geometry. */
async function fetchSheets(path: string, dir: string) {
  const { shadowSize, anims } = parseAnimData((await get(`${path}/AnimData.xml`)).toString());
  mkdirSync(dir, { recursive: true });
  const out: Partial<Record<AnimationName, Geometry>> = {};
  const missing: AnimationName[] = [];
  for (const name of ANIMATIONS) {
    let a = anims.get(name);
    let file: string = name;
    for (let hops = 0; a?.copyOf && hops < 4; hops++) {
      file = a.copyOf;
      a = anims.get(file);
    }
    if (!a) {
      missing.push(name);
      continue;
    }
    const sheet = await get(`${path}/${file}-Anim.png`);
    const png = PNG.sync.read(sheet);
    const frames = png.width / a.w;
    const rows = png.height / a.h;
    if (!Number.isInteger(frames) || !Number.isInteger(rows) || frames !== a.d.length)
      throw new Error(`${path}/${file}: sheet does not match AnimData`);
    writeFileSync(join(dir, `${name}.png`), sheet);
    const anchor = anchorOf(await get(`${path}/${file}-Shadow.png`), a.w, a.h);
    out[name] = { width: a.w, height: a.h, frames, rows, durations: a.d, ...anchor };
  }
  if (!out.Idle || !out.Walk) throw new Error(`${path}: no Idle or Walk`);
  return { shadowSize, animations: out, missing };
}

const only = process.argv.slice(2).map(Number);
const { forms } = MegasFileSchema.parse(
  JSON.parse(readFileSync(join(root, 'packages/data/json/megas.json'), 'utf8')),
);
const tracker = JSON.parse((await get('tracker.json')).toString()) as Record<string, TrackerNode>;
const names = new Map(
  (await get('credit_names.txt'))
    .toString()
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 2)
    .map(([name, discord, contact]) => [discord!.trim(), { name: name!, contact: contact ?? '' }]),
);
const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as { pokemon: MetadataEntry[] };
const credits = new Map<string, { contact: string; forms: string[] }>();

for (const form of forms) {
  if (only.length && !only.includes(form.dex)) continue;
  const dex4 = String(form.dex).padStart(4, '0');
  const node = tracker[dex4]?.subgroups[form.spriteCollab];
  if (!node) throw new Error(`${dex4}/${form.spriteCollab}: not in the tracker`);
  const base = metadata.pokemon.find((p) => p.dex === form.dex && !p.form);
  if (!base) throw new Error(`${form.dex}: no base form in sprite-metadata.json`);
  const key = `${form.dex}-${form.kind}`;
  const dir = join(root, 'assets/pokemon', key);
  rmSync(dir, { recursive: true, force: true });
  const path = `sprite/${dex4}/${form.spriteCollab}`;
  const normal = await fetchSheets(path, dir);
  const shinyNode = node.subgroups['0001'];
  const shiny = (shinyNode?.sprite_complete ?? 0) >= 1;
  const entry: MetadataEntry = {
    dex: form.dex,
    form: form.kind,
    shadowSize: normal.shadowSize,
    hovers: base.hovers,
    shiny,
    animations: normal.animations,
  };
  if (shiny) {
    const s = await fetchSheets(`${path}/0001`, join(dir, 's'));
    const differs = Object.fromEntries(
      Object.entries(s.animations).filter(
        ([name, g]) =>
          JSON.stringify(g) !== JSON.stringify(normal.animations[name as AnimationName]),
      ),
    );
    if (Object.keys(s.animations).join() !== Object.keys(normal.animations).join())
      throw new Error(`${path}/0001: not the same animations as the regular sheets`);
    if (Object.keys(differs).length) entry.shinyAnimations = differs;
  }
  const at = metadata.pokemon.findIndex((p) => p.dex === form.dex && p.form === form.kind);
  if (at >= 0) metadata.pokemon[at] = entry;
  else metadata.pokemon.splice(metadata.pokemon.indexOf(base) + 1, 0, entry);
  console.log(
    `${key} (${node.name}): ${Object.keys(normal.animations).length} animations` +
      (normal.missing.length ? `, missing ${normal.missing.join(', ')}` : '') +
      (shiny ? ', shiny' : ', no shiny sheets'),
  );
  for (const n of [node, ...(shiny && shinyNode ? [shinyNode] : [])])
    for (const id of [n.sprite_credit.primary, ...n.sprite_credit.secondary]) {
      const who = names.get(id) ?? { name: id, contact: '' };
      const c = credits.get(who.name) ?? { contact: who.contact, forms: [] };
      if (!c.forms.includes(key)) c.forms.push(key);
      credits.set(who.name, c);
    }
}

writeFileSync(
  metadataFile,
  `{"pokemon":[\n${metadata.pokemon.map((p) => '  ' + JSON.stringify(p)).join(',\n')}\n]}\n`,
);
console.log('\nArtists (CREDITS.md):');
for (const [name, c] of [...credits].sort((a, b) => a[0].localeCompare(b[0])))
  console.log(`| ${name} | ${c.contact} | ${c.forms.join(', ')} |`);
