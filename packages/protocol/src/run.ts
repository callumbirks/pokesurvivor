import type { BalanceRecord } from './balance.js';

/**
 * What one player achieved in a run. The browser produces it for solo runs (`POST /api/runs`,
 * where the server sanity-caps it) and the server's own sim produces it for coop runs
 * (`recordCoopRun`). It drives rewards, stats, missions and achievements.
 */
export interface RunSummary {
  /** Seconds survived. */
  durationS: number;
  /** Player level reached. */
  level: number;
  /** Enemies defeated, bosses included. */
  kills: number;
  /** Bosses defeated, rift legendaries included. */
  bosses: number;
  /** The run's total coin reward as the game computes it at the end of the run. */
  coins: number;
  /** Gacha tickets picked up. */
  ticketsX1: number;
  ticketsX10: number;
  /** Gems picked up (R6). Optional: older clients don't send it (0). */
  gems?: number;
  /** Dex numbers of wild shinies caught (each also grants the normal form). */
  shiniesCaught: number[];
  progress: RunProgress;
  /**
   * The player's balance record (analytics for the admin run export; never credited). Optional:
   * older clients don't send it, and the server drops one that doesn't validate.
   */
  balance?: BalanceRecord;
}

/**
 * Per-run counters that missions and achievements need beyond the totals in `RunSummary`. These
 * mirror the events of original `systems/progress.js` (`kill`, `chest`, `item`, `evolve`, `rift`),
 * accumulated over the run instead of sent one by one.
 */
export interface RunProgress {
  /**
   * Defeats per elemental type id (`fire`, `water`, … as in `@pokesurvivor/data`). A defeated
   * enemy counts once for each of its types, so a fire/flying enemy adds 1 to both.
   */
  defeatsByType: Partial<Record<string, number>>;
  /** Locked chests opened. */
  chestsOpened: number;
  /** Held-item ids, one entry each time the player equipped a different item (original `item`). */
  itemsEquipped: string[];
  /** Move ids (the base move, e.g. `tackle`) each time a move evolved. */
  movesEvolved: string[];
  /** The arena type of each rift battle won, e.g. `["fire"]`. */
  riftWins: string[];
  /** Dex numbers of the rift legendaries defeated. */
  legendariesDefeated: number[];
  /**
   * Dex numbers of lost Pokémon brought home whose "joins you" roll succeeded (legacy
   * `events.js`: 20% of rescues). They join the collection if not already owned; the 150-coin
   * consolation for an owned one is part of `coins`.
   */
  rescued: number[];
}

export function emptyRunProgress(): RunProgress {
  return {
    defeatsByType: {},
    chestsOpened: 0,
    itemsEquipped: [],
    movesEvolved: [],
    riftWins: [],
    legendariesDefeated: [],
    rescued: [],
  };
}
