// The sprite manifest must match the files in assets/pokemon/ exactly.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/index.js';
import { ANIMATIONS } from '../src/schemas/index.js';
import { loadSpriteManifest, spriteUrl } from '../src/sprites.js';

const spritesDir = resolve(import.meta.dirname, '../../../assets/pokemon');
const manifest = loadSpriteManifest();

/** Same hash as tools/sprites/generate.ts. */
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

describe('sprite manifest', () => {
  it('has an entry for every Pokémon and every sprite directory', () => {
    const inManifest = manifest.pokemon.map((p) => p.dex);
    const onDisk = readdirSync(spritesDir)
      .map(Number)
      .sort((a, b) => a - b);
    expect(inManifest).toEqual(onDisk);
    expect(inManifest).toEqual(loadGameData().pokedex.map((p) => p.dex));
  });

  it('points at sheets that exist, shiny ones included', () => {
    const missing: string[] = [];
    for (const p of manifest.pokemon) {
      const dir = join(spritesDir, String(p.dex));
      for (const anim of ANIMATIONS) {
        if (!existsSync(join(dir, `${anim}.png`))) missing.push(`${p.dex}/${anim}.png`);
        if (p.shiny && !existsSync(join(dir, 's', `${anim}.png`)))
          missing.push(`${p.dex}/s/${anim}.png`);
      }
      expect(existsSync(join(dir, 's')), `${p.dex}/s exists iff shiny`).toBe(p.shiny);
    }
    expect(missing).toEqual([]);
  });

  it('has up-to-date content hashes', () => {
    const stale = manifest.pokemon.filter(
      (p) => hashDir(join(spritesDir, String(p.dex))) !== p.hash,
    );
    expect(
      stale.map((p) => p.dex),
      'run pnpm --filter @pokesurvivor/tools generate-sprites',
    ).toEqual([]);
  });

  it('agrees with bodies.json (the sizes the sim uses)', () => {
    const { bodyByDex } = loadGameData();
    expect(bodyByDex.size).toBe(manifest.pokemon.length);
    for (const p of manifest.pokemon) {
      const idle = p.animations.Idle ?? p.animations.Walk;
      const body = bodyByDex.get(p.dex);
      expect(body, `${p.dex}`).toEqual({
        dex: p.dex,
        radius: Math.min(26, Math.max(5, (idle?.width ?? 32) * 0.22)) * 2,
        height: (idle?.anchorY ?? 24) * 2,
        hovers: p.hovers,
        shiny: p.shiny,
      });
    }
  });

  it('builds cache-busting URLs', () => {
    const pikachu = manifest.byDex.get(25)!;
    expect(spriteUrl(manifest, pikachu, 'Walk', true)).toBe(
      `/sprites/25/s/Walk.png?v=${pikachu.hash}`,
    );
  });
});
