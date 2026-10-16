// Which moves a Pokémon starts with and can learn, as the server checks them for move bindings
// bans and the Repertoire move (`startingMoveOf` / `movePoolOf` in apps/server/src/data.ts).
import type { Move, Pokemon } from '@pokesurvivor/data';
import { gameData } from './dom.js';

export function startingMoveOf(pokemon: Pokemon): string {
  const data = gameData();
  const starter = data.starterByDex.get(pokemon.dex);
  if (starter) return starter.startingMove;
  return data.moves.startingMoves[pokemon.types[0] ?? 'normal'];
}

/** Normal moves plus the moves of the Pokémon's types, each once. */
export function movePoolOf(pokemon: Pokemon): Move[] {
  const data = gameData();
  const seen = new Set<string>();
  const out: Move[] = [];
  for (const type of ['normal', ...pokemon.types] as const) {
    for (const move of data.movesByType.get(type) ?? []) {
      if (seen.has(move.id)) continue;
      seen.add(move.id);
      out.push(move);
    }
  }
  return out;
}

/** The moves that can go in a binding slot: the starting move first, then the pool. */
export function bindableMoves(pokemon: Pokemon): Move[] {
  const start = startingMoveOf(pokemon);
  const first = gameData().moveById.get(start);
  const pool = movePoolOf(pokemon).filter((m) => m.id !== start);
  return first ? [first, ...pool] : pool;
}

/**
 * The moves "Repertoire" can start a run with as the second move: the pool's attacking moves
 * other than the starting move, minus the banned ones (the server and the sim check the same).
 */
export function repertoireMoves(pokemon: Pokemon, bans: readonly string[]): Move[] {
  const start = startingMoveOf(pokemon);
  return movePoolOf(pokemon).filter(
    (m) => m.id !== start && m.kind !== 'buff' && !bans.includes(m.id),
  );
}
