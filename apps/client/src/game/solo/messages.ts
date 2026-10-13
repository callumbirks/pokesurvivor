// Messages between the solo connection (main thread) and the sim's Web Worker.
import type { Game, ResultSummary } from '@pokesurvivor/netclient';
import type { RunSummary } from '@pokesurvivor/protocol';
import type { Intent, PlayerConfig, SimState } from '@pokesurvivor/sim';
import type { ChoiceResult } from '@pokesurvivor/sim';

export type ToWorker =
  | {
      type: 'init';
      seed: number;
      loadout: PlayerConfig;
      username: string;
      owned: number[];
      /** Dev and perf tests only: simulate this many minutes first (cards picked for you). */
      skipMinutes?: number;
      /** Dev and perf tests only: the player can't be hurt. */
      invulnerable?: boolean;
      /** Resume a saved run: the sim at its last checkpoint (instead of a new run). */
      restore?: SimState;
      /** Send a reported `checkpoint` every this many seconds of run time (none if unset). */
      checkpointEveryS?: number;
      /** Send a `checkpoint` to save locally as the run starts and every this many seconds. */
      saveEveryS?: number;
    }
  /** Assets loaded: the run starts. */
  | { type: 'start' }
  | { type: 'input'; seq: number; moveX: number; moveY: number; slot: number | null }
  | { type: 'intent'; rid: number; intent: Intent }
  | { type: 'pause'; paused: boolean }
  /** The client lost track of the deltas: the next snapshot is full. */
  | { type: 'resync' }
  /** Send a `checkpoint` now (a keep-alive while the run is paused or waiting on a choice). */
  | { type: 'checkpoint' }
  /** The player gave up: the run ends now. */
  | { type: 'quit' }
  /** Dev page only: trigger a rift, the arena, an event or weather (like /?debug-sim). */
  | { type: 'debug'; action: DevAction };

export type DevAction = 'rift' | 'arena' | 'horde' | 'gold' | 'lost' | 'thief' | 'weather';

export type FromWorker =
  /** The run is built (its static info, roster included): load its assets. */
  | { type: 'ready'; game: Game }
  /** A snapshot frame (binary, like the server's). */
  | { type: 'frame'; data: Uint8Array }
  | { type: 'reply'; rid: number; result: ChoiceResult }
  /**
   * The run so far and the sim's state, to save for a resume; `report`: also report the summary
   * to the server as a checkpoint.
   */
  | { type: 'checkpoint'; summary: RunSummary; state: SimState; report: boolean }
  /** The run is over: the player's results, to report. */
  | { type: 'ended'; reason: string; summary: ResultSummary }
  | { type: 'error'; message: string };
