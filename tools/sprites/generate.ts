// Regenerate the sprite manifest and collision bodies from assets only.
// PNGs have no timing/anchor metadata: keep those facts in assets/sprite-metadata.json.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import {
  AnimationNameSchema,
  BodiesFileSchema,
  PokemonSpritesSchema,
  SpriteAnimationSchema,
  SpriteManifestSchema,
} from '@pokesurvivor/data/schemas';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '../..');
const spritesDir = join(root, 'assets/pokemon');
const geometry = SpriteAnimationSchema.omit({ bounds: true });
const metadataSchema = z.strictObject({
  pokemon: z.array(
    z.strictObject({
      ...PokemonSpritesSchema.pick({ dex: true, shadowSize: true, hovers: true, shiny: true })
        .shape,
      animations: z.record(AnimationNameSchema, geometry),
      shinyAnimations: z.partialRecord(AnimationNameSchema, geometry).optional(),
    }),
  ),
});
const metadata = metadataSchema.parse(
  JSON.parse(readFileSync(join(root, 'assets/sprite-metadata.json'), 'utf8')),
);
const byDex = new Map(metadata.pokemon.map((p) => [p.dex, p]));

function hashDir(dir: string): string {
  const hash = createHash('sha1');
  const visit = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) visit(join(d, entry.name), `${rel}${entry.name}/`);
      else {
        hash.update(rel + entry.name + '\0');
        hash.update(readFileSync(join(d, entry.name)));
      }
    }
  };
  visit(dir, '');
  return hash.digest('hex').slice(0, 8);
}

type Animation = z.infer<typeof geometry>;
function animation(file: string, a: Animation) {
  const png = PNG.sync.read(readFileSync(file));
  const { width: w, height: h, frames, rows } = a;
  if (png.width !== w * frames || png.height !== h * rows)
    throw new Error(`${file}: sheet dimensions do not match the animation metadata`);
  let left = w;
  let top = h;
  let right = 0;
  let bottom = 0;
  // Opaque bounds over every frame of the facing-down row.
  for (let f = 0; f < frames; f++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (png.data[(y * png.width + f * w + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
  return {
    ...a,
    bounds: right > left ? { left, top, right, bottom } : { left: 0, top: 0, right: w, bottom: h },
  };
}
function animations(dir: string, anims: Record<string, Animation>) {
  return Object.fromEntries(
    Object.entries(anims).map(([name, a]) => [name, animation(join(dir, `${name}.png`), a)]),
  );
}

const dexes = readdirSync(spritesDir)
  .map(Number)
  .sort((a, b) => a - b);
if (dexes.length !== byDex.size || dexes.some((dex) => !byDex.has(dex)))
  throw new Error('Sprite directories and assets/sprite-metadata.json must list the same Pokémon');
const sprites = SpriteManifestSchema.parse({
  basePath: '/sprites',
  pokemon: dexes.map((dex) => {
    const p = byDex.get(dex)!;
    const dir = join(spritesDir, String(dex));
    const shiny = readdirSync(dir).includes('s');
    const { shinyAnimations: overrides, ...normal } = p;
    if (shiny) animations(join(dir, 's'), { ...p.animations, ...overrides });
    return {
      ...normal,
      hash: hashDir(dir),
      shiny,
      animations: animations(dir, p.animations),
      ...(shiny && overrides ? { shinyAnimations: animations(join(dir, 's'), overrides) } : {}),
    };
  }),
});
const bodies = BodiesFileSchema.parse({
  bodies: sprites.pokemon.map((p) => {
    const idle = p.animations.Idle ?? p.animations.Walk;
    return {
      dex: p.dex,
      radius: Math.min(26, Math.max(5, (idle?.width ?? 32) * 0.22)) * 2,
      height: (idle?.anchorY ?? 24) * 2,
      hovers: p.hovers,
      shiny: p.shiny,
    };
  }),
});
// One Pokémon per line, matching the source tables' compact format.
function write(file: string, header: string, rows: unknown[]) {
  writeFileSync(
    join(root, 'packages/data/json', file),
    `${header}[\n${rows.map((p) => '  ' + JSON.stringify(p)).join(',\n')}\n]}\n`,
  );
  console.log(`wrote ${file}`);
}
write('sprites.json', '{"basePath":"/sprites","pokemon":', sprites.pokemon);
write('bodies.json', '{"bodies":', bodies.bodies);
