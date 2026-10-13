// Messages between the solo connection (main thread) and the sim's Web Worker.
import type { Game, ResultSummary } from '@pokesurvivor/netclient';
import type { Intent, PlayerConfig } from '@pokesurvivor/sim';
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
    }
  /** Assets loaded: the run starts. */
  | { type: 'start' }
  | { type: 'input'; seq: number; moveX: number; moveY: number; slot: number | null }
  | { type: 'intent'; rid: number; intent: Intent }
  | { type: 'pause'; paused: boolean }
  /** The client lost track of the deltas: the next snapshot is full. */
  | { type: 'resync' }
  /** The player gave up: the run ends now. */
  | { type: 'quit' };

export type FromWorker =
  /** The run is built (its static info, roster included): load its assets. */
  | { type: 'ready'; game: Game }
  /** A snapshot frame (binary, like the server's). */
  | { type: 'frame'; data: Uint8Array }
  | { type: 'reply'; rid: number; result: ChoiceResult }
  /** The run is over: the player's results, to report. */
  | { type: 'ended'; reason: string; summary: ResultSummary }
  | { type: 'error'; message: string };
