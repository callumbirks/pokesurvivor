// The sprite manifest is its own entry point (`@pokesurvivor/data/sprites`) because it's large:
// the server and the sim don't need it, and the client can load it lazily.
import spritesJson from '../json/sprites.json' with { type: 'json' };
import { indexBy, parseDataFile } from './util.js';
import { SpriteManifestSchema, type PokemonSprites, type SpriteManifest } from './schemas/index.js';

export const rawSprites = spritesJson;

export interface SpriteData extends SpriteManifest {
  /** Base forms. */
  byDex: ReadonlyMap<number, PokemonSprites>;
  /** Every entry by its sprite key (`spriteKey`): `"6"`, `"6-mega"`. */
  byKey: ReadonlyMap<string, PokemonSprites>;
}

/** The directory (under `basePath`) and lookup key of an entry: its dex, or `{dex}-{form}`. */
export const spriteKey = (p: Pick<PokemonSprites, 'dex' | 'form'>): string =>
  p.form ? `${p.dex}-${p.form}` : String(p.dex);

let spriteData: SpriteData | undefined;

/** Validates the sprite manifest (once) and returns it with a by-dex lookup. Throws if invalid. */
export function loadSpriteManifest(): SpriteData {
  if (spriteData) return spriteData;
  const manifest = parseDataFile('sprites', SpriteManifestSchema, rawSprites);
  spriteData = {
    ...manifest,
    byDex: indexBy(
      manifest.pokemon.filter((p) => !p.form),
      (p) => p.dex,
      'sprite dex',
    ),
    byKey: indexBy(manifest.pokemon, spriteKey, 'sprite key'),
  };
  return spriteData;
}

/** URL of a sprite sheet, with the content hash that busts the long-lived cache. */
export function spriteUrl(
  manifest: Pick<SpriteManifest, 'basePath'>,
  pokemon: PokemonSprites,
  animation: keyof PokemonSprites['animations'],
  shiny = false,
): string {
  const dir = shiny && pokemon.shiny ? 's/' : '';
  return `${manifest.basePath}/${spriteKey(pokemon)}/${dir}${animation}.png?v=${pokemon.hash}`;
}
