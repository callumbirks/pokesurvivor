import { loadGameData, POKEMON_TYPES } from '@pokesurvivor/data';
import type { GameData, Move, Pokemon, PokemonSprites, PokemonType } from '@pokesurvivor/data';
import { loadSpriteManifest } from '@pokesurvivor/data/sprites';
import { z } from 'zod';

/**
 * The game data the server validates against (`@pokesurvivor/data`), plus the lookups derived
 * from it. Loaded once on first use.
 */
export interface ServerData extends GameData {
  spritesByDex: ReadonlyMap<number, PokemonSprites>;
  /** Legacy only uses Pokémon that have sprites (gacha pools, rift legends, lost Pokémon). */
  hasSprite: (dex: number) => boolean;
  hasShinySprite: (dex: number) => boolean;
  /** The move a Pokémon starts runs with: its starter move, or its first type's (legacy `startMoveOf`). */
  startingMoveOf(pokemon: Pokemon): string;
  /** Moves that can show up in a Pokémon's level-up cards: normal plus its types (legacy `poolFor`). */
  movePoolOf(pokemon: Pokemon): readonly Move[];
}

let serverData: ServerData | undefined;

export function getServerData(): ServerData {
  if (serverData) return serverData;
  const data = loadGameData();
  const sprites = loadSpriteManifest().byDex;
  serverData = {
    ...data,
    spritesByDex: sprites,
    hasSprite: (dex) => sprites.has(dex),
    hasShinySprite: (dex) => sprites.get(dex)?.shiny ?? false,
    startingMoveOf(pokemon) {
      const starter = data.starterByDex.get(pokemon.dex);
      if (starter) return starter.startingMove;
      return data.moves.startingMoves[pokemon.types[0] ?? 'normal'];
    },
    movePoolOf(pokemon) {
      const ids = new Set<string>();
      const out: Move[] = [];
      for (const type of ['normal' as PokemonType, ...pokemon.types]) {
        for (const move of data.movesByType.get(type) ?? []) {
          if (ids.has(move.id)) continue;
          ids.add(move.id);
          out.push(move);
        }
      }
      return out;
    },
  };
  return serverData;
}

/** A dex number that exists in the pokedex. Use for request bodies. */
export const knownDexSchema = z
  .number()
  .int()
  .refine((dex) => getServerData().pokemonByDex.has(dex), { message: 'Unknown Pokémon' });

export const pokemonTypeSchema = z.enum(POKEMON_TYPES);

/** The Pokémon with that dex number; throws if it doesn't exist (validate input first). */
export function pokemonOf(dex: number): Pokemon {
  const pokemon = getServerData().pokemonByDex.get(dex);
  if (!pokemon) throw new Error(`Unknown Pokémon ${dex}`);
  return pokemon;
}
