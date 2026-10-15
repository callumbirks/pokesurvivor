// The WebSocket protocol: JSON text messages for the session, lobby and room, binary frames for
// snapshots (see snapshot frames in `tables.ts`). docs/protocol.md describes the flow.
//
// This package doesn't depend on the simulation: where a message carries the sim's own types
// (intents, pending choices, events, the roster) it is generic, and `@pokesurvivor/netclient`
// binds the parameters to `@pokesurvivor/sim`'s types. Unknown intent types, choice kinds and
// events pass through unchanged.

/** Bumped on every breaking change to the wire format. */
export const PROTOCOL_VERSION = 7;

/** Largest client message the server accepts, in bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
export const MAX_ROOM_MEMBERS = 4;

/** Close codes (4000–4999 are the application's). */
export const CloseCode = {
  /** The server is restarting (deploy): reconnect with backoff. */
  restarting: 1012,
  /** Malformed messages, too many of them, or no hello in time. */
  protocolError: 4400,
  /** Not logged in: don't reconnect; log in first. */
  unauthenticated: 4401,
  /** Client and server protocol versions differ: reload the page. */
  versionMismatch: 4426,
  /** The same user connected again elsewhere: don't reconnect. */
  superseded: 4409,
  /** Missed heartbeats. */
  timeout: 4408,
  /** Sent too many messages. */
  rateLimited: 4429,
} as const;

/** Codes after which the client must not reconnect on its own. */
export const FINAL_CLOSE_CODES: readonly number[] = [
  CloseCode.unauthenticated,
  CloseCode.versionMismatch,
  CloseCode.superseded,
];

export type PresenceStatus = 'offline' | 'online' | 'in_lobby' | 'in_game';

/**
 * What an online friend is doing, next to their `PresenceStatus` (absent when offline). `menu`:
 * anywhere outside a run (a room's lobby too; the status says `in_lobby`). In a run: their
 * Pokémon and the run time in seconds when the message was sent; the client ticks it on locally
 * unless `paused` (a pause, a pending choice, or loading). The server re-sends it when the
 * clock is paused or resumed or drifts, never every second.
 */
export type FriendActivity =
  | { kind: 'menu' }
  | { kind: 'solo' | 'coop'; dex: number; shiny: boolean; elapsedS: number; paused?: true };

/** A solo run's clock, reported by its client (`activity` message); null: not in a solo run. */
export interface SoloClock {
  runId: string;
  /** Run time in seconds. */
  elapsedS: number;
  /** Not advancing: paused, waiting on a choice, or loading. */
  paused: boolean;
}

/** One friend's presence: `activity` is absent when offline (and from older servers). */
export interface FriendPresence {
  username: string;
  status: PresenceStatus;
  activity?: FriendActivity;
}
/** `busy`: in the gacha, shop, collection or settings. The owner can only start when everyone is `ready`. */
export type MemberStatus = 'ready' | 'not-ready' | 'busy';
export type RoomPhase = 'lobby' | 'loading' | 'running' | 'ended';

export interface RoomMember {
  userId: string;
  username: string;
  status: MemberStatus;
  /** Has a WebSocket open. */
  connected: boolean;
  /** Plays in the current game (false in the lobby, or if dropped at loading). */
  inGame: boolean;
  /** Acked "loaded" (during `loading`). */
  loaded: boolean;
  /** The partner from their save (what they'll play), or null if none is chosen. */
  partner: { dex: number; shiny: boolean } | null;
}

export interface RoomView {
  id: string;
  phase: RoomPhase;
  ownerId: string;
  members: RoomMember[];
  /** Usernames with a pending invite. */
  invited: string[];
  maxMembers: number;
  /** Members who keep the owner from starting (not ready, busy, or without a partner). */
  blockers: string[];
  /** `loading`: server time (ms) when members who haven't loaded are dropped. */
  loadingDeadline: number | null;
}

export interface PlayerLoadout {
  /** The player's user id: the sim's player id. */
  id: string;
  username: string;
  /** Join order in the run (colour slot). */
  index: number;
  dex: number;
  shiny: boolean;
}

/** Sent once when a game starts loading, starts, or is resumed. */
export interface GameStatic<Roster = unknown> {
  roomId: string;
  /** Changes with every new game in the room. */
  gameId: string;
  seed: number;
  tickHz: number;
  /** Snapshots per second. */
  snapshotHz: number;
  /** Seconds before a pending choice resolves by itself (null: never). */
  choiceTimeoutS: number | null;
  /** This run's wild Pokémon per tier and its bosses (the sim's `RosterState`). */
  roster: Roster;
  players: PlayerLoadout[];
}

export interface PlayerResult<Summary = unknown> {
  userId: string;
  username: string;
  /** Left (or dropped) before the end: credited with what was earned until then. */
  left: boolean;
  summary: Summary;
  /**
   * Achievements this run unlocked for the player, with the reward each credited (on top of the
   * run's own coins and tickets). Absent if the run wasn't recorded.
   */
  achievements?: UnlockedAchievement[];
}

/** An achievement unlocked and paid by the server (as in `POST /api/runs`). */
export interface UnlockedAchievement {
  id: string;
  reward: { coins?: number; tickets?: number; tickets10?: number };
  title: string | null;
}

export interface GameResults<Summary = unknown> {
  gameId: string;
  /** The `runs` row, or null if recording failed (see `credited`). */
  runId: string | null;
  credited: boolean;
  reason: string;
  players: PlayerResult<Summary>[];
}

export type FriendEventName = 'request_received' | 'request_accepted' | 'friend_removed';

export type NoticeCode =
  | 'dropped-at-loading'
  | 'player-disconnected'
  | 'player-reconnected'
  | 'player-left'
  | 'player-removed'
  | 'owner-changed'
  | 'kicked'
  | 'game-cancelled'
  | 'server-draining'
  | 'room-handoff-pending'
  | 'room-handoff-expired';

// ------------------------------------------------------------------ client → server

/** Input sent every tick while playing. `seq` increases by one per message. */
export interface InputMessage {
  type: 'input';
  /**
   * The game it's for: inputs for any other game (a previous one, or before the next one has
   * started) are ignored. `seq` counts from 1 per game, and per socket within a game.
   */
  gameId: string;
  seq: number;
  moveX: number;
  moveY: number;
  /** Switch to this move slot (send once per key press). */
  slot?: number | null;
  /**
   * Manual aim, quantised to `AIM_STEPS` (`encodeAim` / `decodeAim`): attacks go this way.
   * Absent: auto-aim. Persists like movement, so it's in every input while manual aim is on.
   */
  aim?: number;
  /**
   * Fire held (the mouse button or a trigger): aimed moves fire even with nothing in reach. Only
   * with `aim`, and only sent while held (absent: not held).
   */
  fire?: true;
}

/** Steps of a quantised aim angle (one byte: ~1.4° each). */
export const AIM_STEPS = 256;

/** An angle (radians, any range) as an `InputMessage.aim`: an integer in [0, AIM_STEPS). */
export function encodeAim(angle: number): number {
  const q = Math.round((angle / (2 * Math.PI)) * AIM_STEPS) % AIM_STEPS;
  return q < 0 ? q + AIM_STEPS : q;
}

/** An `InputMessage.aim` back to radians, in (−π, π]. */
export function decodeAim(q: number): number {
  const a = (q / AIM_STEPS) * 2 * Math.PI;
  return a > Math.PI ? a - 2 * Math.PI : a;
}

/** An angle snapped to what the server will see (what `decodeAim(encodeAim(angle))` gives). */
export const quantizeAim = (angle: number): number => decodeAim(encodeAim(angle));

export type IntentValue = string | number | boolean | null;

/**
 * An object with a `type` and a few primitive (or short primitive-array) fields: the sim's
 * `Intent`, validated generically so new intents pass through. The sim checks the fields.
 */
export interface WireIntent {
  type: string;
  [key: string]: IntentValue | IntentValue[];
}

export type ClientRequest<Intent = WireIntent> =
  | { type: 'room.create' }
  | { type: 'room.invite'; username: string }
  /** Accepts an invite: joins the room. */
  | { type: 'room.join'; roomId: string }
  | { type: 'invite.decline'; roomId: string }
  | { type: 'room.leave' }
  | { type: 'room.kick'; userId: string }
  | { type: 'room.status'; status: MemberStatus }
  | { type: 'room.start' }
  /** `gameId`: intents for any other game are rejected (choice ids restart in every game). */
  | { type: 'intent'; gameId: string; intent: Intent };

export type ClientMessage<Intent = WireIntent> =
  | { type: 'hello'; protocolVersion: number }
  | { type: 'ping'; id: number; sentAt: number }
  | { type: 'game.loaded'; gameId: string }
  /** The client couldn't apply a snapshot: the next one must be full. */
  | { type: 'game.resync'; gameId: string }
  /**
   * Your solo run's clock for your friends' presence (on start, pause and resume, at checkpoints,
   * and after a reconnect); `solo: null` when the run is over. The server checks the run is yours
   * and open, and takes the Pokémon from it.
   */
  | { type: 'activity'; solo: SoloClock | null }
  | InputMessage
  /** `rid`: request id, echoed in the `reply`. */
  | (ClientRequest<Intent> & { rid: number });

export type RequestType = ClientRequest['type'];

// ------------------------------------------------------------------ server → client

export interface ErrorInfo {
  code: string;
  message: string;
}

export type ServerMessage<Roster = unknown, Summary = unknown> =
  | {
      type: 'welcome';
      protocolVersion: number;
      userId: string;
      username: string;
      serverTime: number;
      /** How often to ping; the server drops sockets silent for ~5 of these. */
      heartbeatMs: number;
      /** The server is shutting down (no new games). */
      draining: boolean;
      /**
       * The deployed build's id (absent in development). A client built differently is an older
       * or newer bundle and should offer a reload; unlike `protocolVersion`, it still works.
       */
      build?: string;
      /** The deployed build's version label (`v10`, `v10+dev`), sent with `build`. */
      version?: string;
    }
  | { type: 'pong'; id: number; sentAt: number; serverTime: number }
  | ({ type: 'reply'; rid: number } & (
      { ok: true; data?: unknown } | { ok: false; error: ErrorInfo }
    ))
  /** Unsolicited error, e.g. right before the server closes the socket. */
  | { type: 'error'; error: ErrorInfo }
  /** The room you're in (after every change), or null when you're in none. */
  | { type: 'room'; room: RoomView | null }
  | { type: 'invite'; roomId: string; from: string; expiresAt: number }
  | { type: 'invite.revoked'; roomId: string }
  | { type: 'invite.declined'; roomId: string; username: string }
  /** Every friend's presence (on connect). */
  | { type: 'presence'; friends: FriendPresence[] }
  | ({ type: 'presence.update' } & FriendPresence)
  | { type: 'friend'; event: FriendEventName; username: string }
  | { type: 'notice'; code: NoticeCode; usernames?: string[]; deadline?: number }
  /** A game is loading: load sprites for the roster and players, then send `game.loaded`. */
  | { type: 'game.loading'; game: GameStatic<Roster>; deadline: number }
  /** The game runs (or you resumed it): a full snapshot follows. */
  | { type: 'game.start'; game: GameStatic<Roster>; resumed: boolean }
  | { type: 'game.results'; results: GameResults<Summary> }
  /**
   * The server's game loop fell behind (diagnostics for the in-game network stats). Sent to the
   * players of running games when it happens, at most once a second, adding up since the last
   * one: `late` ticks that ran over a tick late (it caught up), `skipped` times it was so far
   * behind that it skipped ticks, `worstMs` the most it was behind. Optional: older clients
   * ignore it (no version bump).
   */
  | { type: 'server.lag'; late: number; skipped: number; worstMs: number };

export type ServerMessageType = ServerMessage['type'];
