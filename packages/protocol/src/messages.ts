// The WebSocket protocol: JSON text messages for the session, lobby and room, binary frames for
// snapshots (see snapshot frames in `tables.ts`). docs/protocol.md describes the flow.
//
// This package doesn't depend on the simulation: where a message carries the sim's own types
// (intents, pending choices, events, the roster) it is generic, and `@pokesurvivor/netclient`
// binds the parameters to `@pokesurvivor/sim`'s types. Unknown intent types, choice kinds and
// events pass through unchanged.

/** Bumped on every breaking change to the wire format. */
export const PROTOCOL_VERSION = 4;

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
  | 'server-draining';

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
}

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
  | { type: 'presence'; friends: { username: string; status: PresenceStatus }[] }
  | { type: 'presence.update'; username: string; status: PresenceStatus }
  | { type: 'friend'; event: FriendEventName; username: string }
  | { type: 'notice'; code: NoticeCode; usernames?: string[]; deadline?: number }
  /** A game is loading: load sprites for the roster and players, then send `game.loaded`. */
  | { type: 'game.loading'; game: GameStatic<Roster>; deadline: number }
  /** The game runs (or you resumed it): a full snapshot follows. */
  | { type: 'game.start'; game: GameStatic<Roster>; resumed: boolean }
  | { type: 'game.results'; results: GameResults<Summary> };

export type ServerMessageType = ServerMessage['type'];
