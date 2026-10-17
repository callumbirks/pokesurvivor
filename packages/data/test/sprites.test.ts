// The sprite manifest must match the files in assets/pokemon/ exactly.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/index.js';
import { ANIMATIONS } from '../src/schemas/index.js';
import { loadSpriteManifest, spriteKey, spriteUrl } from '../src/sprites.js';

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
  it('has an entry for every Pokémon, every form and every sprite directory', () => {
    const inManifest = manifest.pokemon.map(spriteKey).sort();
    expect(inManifest).toEqual(readdirSync(spritesDir).sort());
    const base = manifest.pokemon.filter((p) => !p.form).map((p) => p.dex);
    expect(base).toEqual(loadGameData().pokedex.map((p) => p.dex));
    const forms = manifest.pokemon.filter((p) => p.form).map(spriteKey);
    expect(forms.sort()).toEqual(
      loadGameData()
        .megas.map((m) => `${m.dex}-${m.kind}`)
        .sort(),
    );
  });

  it('points at sheets that exist, shiny ones included', () => {
    const missing: string[] = [];
    for (const p of manifest.pokemon) {
      const key = spriteKey(p);
      const dir = join(spritesDir, key);
      for (const anim of ANIMATIONS) {
        // A form may lack some animations (the client falls back); its manifest says which.
        const listed = anim in p.animations;
        if (existsSync(join(dir, `${anim}.png`)) !== listed) missing.push(`${key}/${anim}.png`);
        if (listed && p.shiny && !existsSync(join(dir, 's', `${anim}.png`)))
          missing.push(`${key}/s/${anim}.png`);
      }
      expect(existsSync(join(dir, 's')), `${key}/s exists iff shiny`).toBe(p.shiny);
    }
    expect(missing).toEqual([]);
  });

  it('has up-to-date content hashes', () => {
    const stale = manifest.pokemon.filter(
      (p) => hashDir(join(spritesDir, spriteKey(p))) !== p.hash,
    );
    expect(stale.map(spriteKey), 'run pnpm --filter @pokesurvivor/tools generate-sprites').toEqual(
      [],
    );
  });

  it('agrees with bodies.json (the sizes the sim uses)', () => {
    const { bodyByDex, megaBodyByDex } = loadGameData();
    expect(bodyByDex.size + megaBodyByDex.size).toBe(manifest.pokemon.length);
    for (const p of manifest.pokemon) {
      const idle = p.animations.Idle ?? p.animations.Walk;
      const body = (p.form ? megaBodyByDex : bodyByDex).get(p.dex);
      expect(body, spriteKey(p)).toEqual({
        dex: p.dex,
        ...(p.form ? { form: p.form } : {}),
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
    const mega = manifest.byKey.get('6-mega')!;
    expect(spriteUrl(manifest, mega, 'Idle')).toBe(`/sprites/6-mega/Idle.png?v=${mega.hash}`);
  });
});
