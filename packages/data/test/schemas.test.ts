import { describe, expect, it } from 'vitest';
import { dataSchemas, loadGameData, rawData } from '../src/index.js';
import { POKEMON_TYPES, PokemonTypeSchema } from '../src/schemas/index.js';
import { loadSpriteManifest, rawSprites } from '../src/sprites.js';
import { SpriteManifestSchema } from '../src/schemas/index.js';

describe('data files', () => {
  it.each(Object.keys(rawData) as (keyof typeof rawData)[])('%s.json matches its schema', (key) => {
    const result = dataSchemas[key].safeParse(rawData[key]);
    expect(result.error?.message).toBeUndefined();
  });

  it('sprites.json matches its schema', () => {
    const result = SpriteManifestSchema.safeParse(rawSprites);
    expect(result.error?.message).toBeUndefined();
  });

  it('loads with lookups', () => {
    const data = loadGameData();
    expect(data.pokemonByDex.get(25)?.name).toBe('Pikachu');
    expect(data.pokemonById.get('type-null')?.dex).toBe(772);
    expect(data.moveById.get('ember')?.type).toBe('fire');
    expect(data.movesByType.get('normal')?.some((m) => m.id === 'tackle')).toBe(true);
    expect(data.starterByDex.get(1)?.startingMove).toBe('vine-whip');
    expect(data.itemById.get('life-orb')?.name).toBe('Life Orb');
    expect(loadGameData()).toBe(data);
    expect(loadSpriteManifest().byDex.get(25)?.animations.Idle?.rows).toBe(8);
  });
});

describe('PokemonTypeSchema', () => {
  it('accepts every known type', () => {
    expect(POKEMON_TYPES).toHaveLength(18);
    for (const type of POKEMON_TYPES) expect(PokemonTypeSchema.parse(type)).toBe(type);
  });

  it('rejects unknown types', () => {
    expect(PokemonTypeSchema.safeParse('fuego').success).toBe(false);
  });
});
