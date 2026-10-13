// The protocol's generic messages bound to the sim's types.
import type {
  ClientRequest,
  GameResults,
  GameStatic,
  RunSummary,
  ServerMessage,
} from '@pokesurvivor/protocol';
import type { Intent, PlayerSummary, RosterState } from '@pokesurvivor/sim';

/** A player's results: what was credited (`RunSummary`) and the sim's breakdown for the screen. */
export interface ResultSummary {
  run: RunSummary;
  player: PlayerSummary | null;
}

export type Game = GameStatic<RosterState>;
export type Results = GameResults<ResultSummary>;
export type ServerMsg = ServerMessage<RosterState, ResultSummary>;
export type Request = ClientRequest<Intent>;

export type IntentResult = { ok: true } | { ok: false; error: string };
