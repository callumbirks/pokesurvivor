// A coop game saved when the server stops for a deploy (`game_saves`), and restored by the next.
import type { Game as GameStatic, ResultSummary } from '@pokesurvivor/netclient';
import type { PlayerConfig } from '@pokesurvivor/sim';
import type { PlayerOutcome } from './game.js';
import type { SavedRoom } from './room.js';

/** Layout of `SavedGame`. Add fields as optional (restores fill them in); bump when that won't do. */
export const SAVED_GAME_VERSION = 1;

export interface SavedSlot {
  userId: string;
  username: string;
  index: number;
  loadout: PlayerConfig;
  /** Pokémon they owned at the start (rescues they own pay coins instead). */
  owned: number[];
  left: boolean;
  /** Their result when they left (credited as is). */
  frozen: ResultSummary | null;
}

export interface SavedGame {
  room: SavedRoom;
  info: GameStatic;
  seed: number;
  /** ISO time the run started (the run's `startedAt` when it's credited). */
  startedAt: string;
  slots: SavedSlot[];
  /** Players who were in it when it was saved: the restored game waits for them. */
  present: string[];
  /**
   * Every player's result as of the save, as `forceEnd` would credit it. If the game can't be
   * restored (an incompatible sim change, a bad row), this is what gets credited.
   */
  outcome: PlayerOutcome[];
  /** The run's time (s) when saved: its duration if it's credited as saved. */
  timeS: number;
}
