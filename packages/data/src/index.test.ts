import { describe, expect, it } from 'vitest';
import { POKEMON_TYPES, PokemonTypeSchema } from './index.js';

describe('PokemonTypeSchema', () => {
  it('accepts every known type', () => {
    expect(POKEMON_TYPES).toHaveLength(18);
    for (const type of POKEMON_TYPES) expect(PokemonTypeSchema.parse(type)).toBe(type);
  });

  it('rejects unknown types', () => {
    expect(PokemonTypeSchema.safeParse('fuego').success).toBe(false);
  });
});
