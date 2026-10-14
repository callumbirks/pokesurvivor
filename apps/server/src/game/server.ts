// The WebSocket game server: authenticated sessions (one per user), presence for friends, rooms
// and the authoritative game loop. Mounted on `/ws` by `buildApp`.
import type { Results } from '@pokesurvivor/netclient';
import {
  CloseCode,
  MAX_CLIENT_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeClientMessage,
  type ClientMessage,
  type ErrorInfo,
  type FriendActivity,
  type FriendPresence,
  type PresenceStatus,
  type SoloClock,
} from '@pokesurvivor/protocol';
import { TICK_MS } from '@pokesurvivor/sim';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { authenticateUpgrade } from '../auth/plugin.js';
import { findUserByUsername } from '../auth/users.js';
import type { GameConfig } from '../config.js';
import type { Database } from '../db/index.js';
import type { FriendEvent, FriendNotifier, PresenceSource } from '../friends/presence.js';
import { friendIds } from '../friends/service.js';
import { recordCoopRun } from '../runs/service.js';
import type { Game, GameOutcome, GameSettings } from './game.js';
import { Room, newRoomId } from './room.js';
import { Session } from './session.js';
import { Ticker } from './ticker.js';
import { and, eq, inArray } from 'drizzle-orm';
import { runPlayers, runs, users } from '../db/schema.js';
import {
  SOLO_STALE_MS,
  presenceDiffers,
  run,
  soloActivity,
  type SentPresence,
} from './activity.js';
import { RoomRegistry } from './registry.js';

/** A request failed; the code goes to the client (it maps it to a UI string). */
export class GameError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface GameServerOptions {
  db: Database;
  config: GameConfig;
  log: FastifyBaseLogger;
  /** Missions and leaderboards roll over in this time zone (run results). */
  timeZone: string;
  /** Tests: sim debug flags for every game. */
  simDebug?: GameSettings['simDebug'];
}

/** Sustained messages per second allowed per socket (inputs are 30/s), and the burst on top. */
const RATE_PER_SECOND = 60;
const RATE_BURST = 120;
/** Messages over the limit before the socket is closed. */
const MAX_DROPPED = 300;
const MAX_INVALID = 20;
const HELLO_TIMEOUT_MS = 5000;

interface Connection {
  socket: WebSocket;
  session: Session | null;
  tokens: number;
  refilledAt: number;
  dropped: number;
  invalid: number;
}

export class GameServer implements PresenceSource, FriendNotifier {
  readonly db: Database;
  readonly config: GameConfig;
  readonly log: FastifyBaseLogger;
  readonly gameSettings: GameSettings;
  draining = false;
  stopped = false;
  private drainDeadline: number | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomOf = new Map<string, Room>();
  private readonly friends = new Map<string, Set<string>>();
  /** What each online user's friends were last sent (status and activity). */
  private readonly lastPresence = new Map<string, SentPresence>();
  /** Usernames of users who just went offline (their presence is still being pushed). */
  private readonly lastUsername = new Map<string, string>();
  private readonly games = new Set<Game>();
  private readonly records = new Set<Promise<unknown>>();
  private readonly ticker: Ticker;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly requests = new Set<Promise<void>>();
  readonly registry: RoomRegistry;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly handoffs = new Set<Promise<void>>();
  private readonly handoffErrors: unknown[] = [];
  private settledWaiters: (() => void)[] = [];
  private polling = false;
  private renewing = false;
  private cleaning = false;
  private nextCleanupAt = Date.now() + 30_000;
  private readonly maintenance = new Set<Promise<void>>();
  private readonly adoptions = new Set<Promise<void>>();
  private readonly pendingRoomNotices = new Set<string>();

  constructor(private readonly opts: GameServerOptions) {
    this.db = opts.db;
    this.registry = new RoomRegistry(this.db);
    this.config = opts.config;
    this.log = opts.log;
    this.gameSettings = {
      snapshotHz: Math.min(30, opts.config.snapshotHz),
      choiceTimeoutS: opts.config.choiceTimeoutS,
      simDebug: opts.simDebug,
    };
    this.ticker = new Ticker({
      tickMs: TICK_MS,
      onTick: () => this.tick(),
      onSkip: (ms) =>
        this.log.warn({ behindMs: Math.round(ms) }, 'game loop fell behind; skipping'),
    });
    this.heartbeat = setInterval(() => this.checkHeartbeats(), opts.config.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Registers `/ws`. */
  register(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket, request) => this.accept(socket, request));
  }

  // ---------------------------------------------------------------- lookups (rooms use these)

  sessionOf(userId: string): Session | null {
    const s = this.sessions.get(userId);
    return s?.open ? s : null;
  }

  isOnline(userId: string): boolean {
    return this.sessionOf(userId) !== null;
  }

  setRoomOf(userId: string, room: Room | null): void {
    if (room) {
      this.roomOf.set(userId, room);
      this.pendingRoomNotices.delete(userId);
    } else this.roomOf.delete(userId);
  }

  removeRoom(room: Room, handedOff = false): void {
    this.rooms.delete(room.id);
    if (!handedOff) this.background(() => this.registry.remove(room.id));
    if (room.game && room.game.phase !== 'ended') this.removeGame(room.game);
    if (this.draining) this.checkDrained();
  }

  addGame(game: Game): void {
    this.games.add(game);
    this.ticker.start();
  }

  removeGame(game: Game): void {
    this.games.delete(game);
    if (!this.games.size) this.ticker.stop();
  }

  /** Test and admin access to the live rooms. */
  get liveRooms(): ReadonlyMap<string, Room> {
    return this.rooms;
  }

  roomOfUser(userId: string): Room | null {
    return this.roomOf.get(userId) ?? null;
  }

  /**
   * A player changed their partner (`PUT /api/save/partner`): their room's lobby shows the new
   * one. Not during a game: its loadouts were read at the start, and presence names its Pokémon.
   */
  partnerChanged(userId: string): void {
    const room = this.roomOf.get(userId);
    const member = room?.members.get(userId);
    if (room && member && room.phase === 'lobby') void room.refreshPartner(member);
  }

  private tick(): void {
    for (const game of [...this.games]) {
      try {
        game.tick();
      } catch (err) {
        // A bug in one game must not stop the others: end it and credit what it has.
        this.log.error({ err, gameId: game.id }, 'game tick failed; ending the game');
        this.games.delete(game);
        game.forceEnd('server-error');
      }
    }
  }

  // ---------------------------------------------------------------- presence and friends

  statusOf(userIds: readonly string[]): ReadonlyMap<string, PresenceStatus> {
    return new Map(userIds.map((id) => [id, this.presenceOf(id)]));
  }

  private presenceOf(userId: string): PresenceStatus {
    if (!this.isOnline(userId)) return 'offline';
    const room = this.roomOf.get(userId);
    if (!room) return this.sessions.get(userId)?.solo ? 'in_game' : 'online';
    const inGame = room.members.get(userId)?.inGame;
    return inGame && (room.phase === 'loading' || room.phase === 'running')
      ? 'in_game'
      : 'in_lobby';
  }

  /** What the user is doing, for their friends (undefined when offline). */
  private activityOf(userId: string, now: number): FriendActivity | undefined {
    const session = this.sessionOf(userId);
    if (!session) return undefined;
    const room = this.roomOf.get(userId);
    if (room) {
      const game = room.game;
      const player = game?.info.players.find((p) => p.id === userId);
      if (
        game &&
        player &&
        room.members.get(userId)?.inGame &&
        (room.phase === 'loading' || room.phase === 'running')
      ) {
        const { elapsedS, paused } = game.clock;
        return run('coop', player.dex, player.shiny, elapsedS, paused);
      }
      return { kind: 'menu' };
    }
    return session.solo ? soloActivity(session.solo, now) : { kind: 'menu' };
  }

  private friendPresence(userId: string, username: string, now: number): FriendPresence {
    const status = this.presenceOf(userId);
    const activity = status === 'offline' ? undefined : this.activityOf(userId, now);
    return { username, status, ...(activity ? { activity } : {}) };
  }

  /**
   * Pushes the user's presence to their online friends if it changed in a way they'd see: the
   * status, the activity, a run's pause, or its clock drifting (`presenceDiffers`).
   */
  presenceChanged(userId: string): void {
    const now = Date.now();
    const status = this.presenceOf(userId);
    const activity = status === 'offline' ? undefined : this.activityOf(userId, now);
    if (!presenceDiffers(this.lastPresence.get(userId), status, activity, now)) return;
    if (status === 'offline') this.lastPresence.delete(userId);
    else this.lastPresence.set(userId, { status, activity, at: now });
    const username = this.usernameOf(userId);
    if (!username) return;
    const message = {
      type: 'presence.update' as const,
      username,
      status,
      ...(activity ? { activity } : {}),
    };
    for (const friendId of this.friends.get(userId) ?? []) this.sessionOf(friendId)?.send(message);
  }

  /** Re-checks the presence of everyone in a run (pauses, clock drift, stale solo runs). */
  private refreshRunPresence(): void {
    const now = Date.now();
    for (const session of this.sessions.values())
      if (session.solo && now - session.solo.at > SOLO_STALE_MS) {
        session.solo = null;
        this.presenceChanged(session.userId);
      }
    for (const [userId, sent] of [...this.lastPresence])
      if (sent.activity && sent.activity.kind !== 'menu') this.presenceChanged(userId);
  }

  /**
   * The client reports its solo run's clock. The run must be this user's and still open; its
   * Pokémon comes from the database (checked once per run), the clock from the client (display
   * only, bounded by the time since the run started).
   */
  private async soloClock(session: Session, clock: SoloClock | null): Promise<void> {
    const seq = ++session.soloSeq;
    if (!clock) {
      if (!session.solo) return;
      session.solo = null;
      this.presenceChanged(session.userId);
      return;
    }
    const now = Date.now();
    let known = session.solo?.runId === clock.runId ? session.solo : null;
    if (!known) {
      const [row] = await this.db
        .select({
          dex: runPlayers.pokemonDex,
          shiny: runPlayers.pokemonShiny,
          startedAt: runs.startedAt,
        })
        .from(runs)
        .innerJoin(runPlayers, eq(runPlayers.runId, runs.id))
        .where(
          and(
            eq(runs.id, clock.runId),
            eq(runs.mode, 'solo'),
            eq(runs.status, 'started'),
            eq(runPlayers.userId, session.userId),
          ),
        )
        .catch(() => []); // not a uuid
      if (session.soloSeq !== seq || this.sessions.get(session.userId) !== session) return;
      if (!row) {
        if (session.solo) {
          session.solo = null;
          this.presenceChanged(session.userId);
        }
        return;
      }
      known = {
        runId: clock.runId,
        ...row,
        startedAt: row.startedAt.getTime(),
        elapsedS: 0,
        paused: true,
        at: now,
      };
    }
    session.solo = { ...known, elapsedS: clock.elapsedS, paused: clock.paused, at: Date.now() };
    this.presenceChanged(session.userId);
  }

  /** Solo runs that were reported or credited: they no longer show in presence. */
  soloRunsClosed(runIds: readonly string[], userId?: string): void {
    const sessions = userId ? [this.sessions.get(userId)] : [...this.sessions.values()];
    for (const session of sessions) {
      if (!session?.solo || !runIds.includes(session.solo.runId)) continue;
      session.solo = null;
      session.soloSeq++;
      this.presenceChanged(session.userId);
    }
  }

  private usernameOf(userId: string): string | null {
    return this.sessions.get(userId)?.username ?? this.lastUsername.get(userId) ?? null;
  }

  notify(event: FriendEvent): void {
    void this.applyFriendEvent(event).catch((err: unknown) =>
      this.log.warn({ err, event }, 'friend notification failed'),
    );
  }

  private async applyFriendEvent(event: FriendEvent): Promise<void> {
    const otherId =
      event.type === 'request_received'
        ? event.fromUserId
        : event.type === 'request_accepted'
          ? event.byUserId
          : event.byUserId;
    if (event.type === 'request_accepted') {
      this.friends.get(event.userId)?.add(otherId);
      this.friends.get(otherId)?.add(event.userId);
    } else if (event.type === 'friend_removed') {
      this.friends.get(event.userId)?.delete(otherId);
      this.friends.get(otherId)?.delete(event.userId);
    }
    const target = this.sessionOf(event.userId);
    if (!target) return;
    const username =
      this.usernameOf(otherId) ??
      (
        await this.db.select({ username: users.username }).from(users).where(eq(users.id, otherId))
      )[0]?.username;
    if (!username) return;
    target.send({ type: 'friend', event: event.type, username });
    if (event.type === 'request_accepted') {
      const now = Date.now();
      target.send({ type: 'presence.update', ...this.friendPresence(otherId, username, now) });
      this.sessionOf(otherId)?.send({
        type: 'presence.update',
        ...this.friendPresence(event.userId, target.username, now),
      });
    }
  }

  // ---------------------------------------------------------------- sockets

  private accept(socket: WebSocket, request: FastifyRequest): void {
    const conn: Connection = {
      socket,
      session: null,
      tokens: RATE_BURST,
      refilledAt: Date.now(),
      dropped: 0,
      invalid: 0,
    };
    // Messages that arrive while the cookie is checked wait for it.
    const early: RawData[] = [];
    let ready = false;
    socket.on('message', (data, isBinary) => {
      if (isBinary) return this.protocolError(conn, 'binary messages are not accepted');
      if (!ready) early.push(data);
      else this.receive(conn, data);
    });
    socket.on('close', () => this.socketClosed(conn));
    socket.on('error', (err) => this.log.debug({ err }, 'websocket error'));
    const helloTimer = setTimeout(() => {
      if (!conn.session) this.closeConn(conn, CloseCode.protocolError, 'no hello');
    }, HELLO_TIMEOUT_MS);
    socket.once('close', () => clearTimeout(helloTimer));

    authenticateUpgrade(this.db, request).then(
      (user) => {
        if (!user) {
          this.sendError(socket, { code: 'unauthenticated', message: 'Log in first' });
          socket.close(CloseCode.unauthenticated, 'unauthenticated');
          return;
        }
        (conn as Connection & { user?: typeof user }).user = user;
        ready = true;
        for (const data of early.splice(0)) this.receive(conn, data);
      },
      (err: unknown) => {
        this.log.error({ err }, 'websocket authentication failed');
        socket.close(1011, 'server error');
      },
    );
  }

  private sendError(socket: WebSocket, error: ErrorInfo): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'error', error }));
  }

  private closeConn(conn: Connection, code: number, reason: string): void {
    if (
      conn.socket.readyState === conn.socket.OPEN ||
      conn.socket.readyState === conn.socket.CONNECTING
    )
      conn.socket.close(code, reason);
  }

  private protocolError(conn: Connection, reason: string, rid: number | null = null): void {
    conn.invalid++;
    if (rid !== null)
      conn.session?.send({
        type: 'reply',
        rid,
        ok: false,
        error: { code: 'bad_request', message: reason },
      });
    else this.sendError(conn.socket, { code: 'bad_request', message: reason });
    if (conn.invalid > MAX_INVALID)
      this.closeConn(conn, CloseCode.protocolError, 'too many invalid messages');
  }

  /** Token bucket: false if the message is over the rate limit. */
  private allow(conn: Connection): boolean {
    const now = Date.now();
    conn.tokens = Math.min(
      RATE_BURST,
      conn.tokens + ((now - conn.refilledAt) / 1000) * RATE_PER_SECOND,
    );
    conn.refilledAt = now;
    if (conn.tokens >= 1) {
      conn.tokens -= 1;
      return true;
    }
    if (++conn.dropped > MAX_DROPPED) this.closeConn(conn, CloseCode.rateLimited, 'rate limited');
    return false;
  }

  private receive(conn: Connection, data: RawData): void {
    const raw = Buffer.isBuffer(data)
      ? data
      : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return this.protocolError(conn, 'message too large');
    if (!this.allow(conn)) return;
    const decoded = decodeClientMessage(raw.toString('utf8'));
    if (!decoded.ok) return this.protocolError(conn, decoded.reason, decoded.rid);
    const m = decoded.message;
    if (conn.session) conn.session.lastHeard = Date.now();

    if (m.type === 'hello') return this.hello(conn, m.protocolVersion);
    if (!conn.session) return this.protocolError(conn, 'say hello first');
    const session = conn.session;
    // A superseded socket that is still delivering: only the user's current socket counts.
    if (this.sessions.get(session.userId) !== session) return;
    switch (m.type) {
      case 'ping':
        session.send({ type: 'pong', id: m.id, sentAt: m.sentAt, serverTime: Date.now() });
        return;
      case 'input':
        this.roomOf.get(session.userId)?.game?.input(session.userId, m);
        return;
      case 'game.loaded':
        this.roomOf.get(session.userId)?.loaded(session.userId, m.gameId);
        return;
      case 'game.resync': {
        const game = this.roomOf.get(session.userId)?.game;
        if (game?.id === m.gameId) game.resync(session.userId);
        return;
      }
      case 'activity':
        void this.soloClock(session, m.solo).catch((err: unknown) =>
          this.log.warn({ err }, 'could not check a solo run for presence'),
        );
        return;
      default: {
        const request = this.request(session, m);
        this.requests.add(request);
        void request.finally(() => this.requests.delete(request));
      }
    }
  }

  private hello(conn: Connection, version: number): void {
    const user = (conn as Connection & { user?: { id: string; username: string } }).user;
    if (!user || conn.session) return this.protocolError(conn, 'unexpected hello');
    if (version !== PROTOCOL_VERSION) {
      this.sendError(conn.socket, {
        code: 'version_mismatch',
        message: `Server speaks protocol ${PROTOCOL_VERSION}; reload the page`,
      });
      this.closeConn(conn, CloseCode.versionMismatch, 'version mismatch');
      return;
    }
    const old = this.sessions.get(user.id);
    if (old) {
      old.send({
        type: 'error',
        error: { code: 'superseded', message: 'Connected from elsewhere' },
      });
      old.close(CloseCode.superseded, 'superseded');
    }
    const session = new Session(user.id, user.username, conn.socket);
    conn.session = session;
    this.sessions.set(user.id, session);
    this.pendingRoomNotices.delete(user.id);
    void this.welcome(session).catch((err: unknown) => {
      this.log.error({ err }, 'could not restore room membership');
      session.close(1011, 'room restore failed');
    });
  }

  private async welcome(session: Session): Promise<void> {
    session.send({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      userId: session.userId,
      username: session.username,
      serverTime: Date.now(),
      heartbeatMs: this.config.heartbeatMs,
      draining: this.draining,
    });
    if (this.draining && this.drainDeadline !== null)
      session.send({ type: 'notice', code: 'server-draining', deadline: this.drainDeadline });
    if (!this.draining) await this.adoptFor(session.userId);
    const room = this.roomOf.get(session.userId);
    if (room) room.reconnected(session.userId);
    else {
      session.send({ type: 'room', room: null });
      if (this.draining)
        setTimeout(
          () => session.close(CloseCode.restarting, 'server restarting'),
          this.config.heartbeatMs,
        ).unref();
    }
    for (const r of this.rooms.values()) {
      const invite = r.invites.get(session.userId);
      if (invite)
        session.send({
          type: 'invite',
          roomId: r.id,
          from: r.members.get(r.ownerId)?.username ?? '',
          expiresAt: invite.expiresAt,
        });
    }
    try {
      const ids = await friendIds(this.db, session.userId);
      if (this.sessions.get(session.userId) !== session) return;
      this.friends.set(session.userId, new Set(ids));
      for (const id of ids) this.friends.get(id)?.add(session.userId);
      const names = ids.length
        ? await this.db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, ids))
        : [];
      const byId = new Map(names.map((u) => [u.id, u.username]));
      const now = Date.now();
      session.send({
        type: 'presence',
        friends: ids
          .filter((id) => byId.has(id))
          .map((id) => this.friendPresence(id, byId.get(id) as string, now)),
      });
    } catch (err) {
      this.log.warn({ err }, 'could not load friends for presence');
    }
    this.presenceChanged(session.userId);
  }

  private socketClosed(conn: Connection): void {
    const session = conn.session;
    if (!session) return;
    session.closed = true;
    // Superseded: the new session took over; nothing changes for the room.
    if (this.sessions.get(session.userId) !== session) return;
    this.sessions.delete(session.userId);
    this.pendingRoomNotices.delete(session.userId);
    this.lastUsername.set(session.userId, session.username);
    this.roomOf.get(session.userId)?.disconnected(session.userId);
    this.presenceChanged(session.userId);
    this.friends.delete(session.userId);
    this.lastUsername.delete(session.userId);
    if (this.draining) this.checkDrained();
  }

  private checkHeartbeats(): void {
    // Background I/O never holds the lobby mutation queue. Keep one in-flight job of
    // each kind, so a slow database neither queues work nor delays a local ready/leave.
    if (!this.renewing && this.rooms.size) {
      this.renewing = true;
      this.runMaintenance(this.registry.renew([...this.rooms.keys()]), () => {
        this.renewing = false;
      });
    }
    if (!this.cleaning && Date.now() >= this.nextCleanupAt) {
      this.cleaning = true;
      this.nextCleanupAt = Date.now() + 30_000;
      this.runMaintenance(this.registry.cleanup(), () => {
        this.cleaning = false;
      });
    }
    if (!this.draining && !this.polling && this.pendingRoomNotices.size) {
      this.polling = true;
      this.runMaintenance(this.pollPendingRooms(), () => {
        this.polling = false;
      });
    }
    this.refreshRunPresence();
    const deadline = Date.now() - this.config.heartbeatMs * 5;
    for (const session of this.sessions.values()) {
      if (session.lastHeard < deadline) session.close(CloseCode.timeout, 'heartbeat timeout');
    }
  }

  // ---------------------------------------------------------------- requests

  private async request(session: Session, m: ClientMessage & { rid: number }): Promise<void> {
    try {
      const current = this.roomOf.get(session.userId);
      if (
        current?.transferring ||
        (this.draining && (!current || current.phase === 'lobby' || current.phase === 'loading'))
      )
        throw new GameError('server_draining', 'Your room is moving to the new server');
      // On-demand adoption does its DB work before entering the local mutation queue.
      if (m.type === 'room.join' && !this.rooms.has(m.roomId)) {
        const reserved = await this.registry.room(m.roomId);
        if (reserved?.handoff) await this.adoptRoom(m.roomId);
        else if (reserved)
          throw new GameError('room_pending', 'That room is still on the previous server');
      }
      const mutateLobby = () =>
        this.exclusive(async () => {
          const room = this.roomOf.get(session.userId);
          if (
            room?.transferring ||
            (this.draining && (!room || room.phase === 'lobby' || room.phase === 'loading'))
          )
            throw new GameError('server_draining', 'Your room is moving to the new server');
          return this.handleRequest(session, m);
        });
      // Existing running-game intents/leave/kick stay independent of registry I/O.
      const data =
        current?.phase === 'running' && m.type !== 'room.join' && m.type !== 'room.create'
          ? await this.handleRequest(session, m)
          : await mutateLobby();
      session.send({
        type: 'reply',
        rid: m.rid,
        ok: true,
        ...(data !== undefined ? { data } : {}),
      });
    } catch (err) {
      if (err instanceof GameError) {
        session.send({
          type: 'reply',
          rid: m.rid,
          ok: false,
          error: { code: err.code, message: err.message },
        });
        return;
      }
      this.log.error({ err, type: m.type }, 'game request failed');
      session.send({
        type: 'reply',
        rid: m.rid,
        ok: false,
        error: { code: 'internal', message: 'Something went wrong' },
      });
    }
  }

  private inRoom(userId: string): Room {
    const room = this.roomOf.get(userId);
    if (!room) throw new GameError('not_in_room', 'Not in a room');
    return room;
  }

  private async handleRequest(
    session: Session,
    m: ClientMessage & { rid: number },
  ): Promise<unknown> {
    const { userId, username } = session;
    switch (m.type) {
      case 'room.create': {
        if (this.draining) throw new GameError('server_draining', 'The server is restarting');
        if (this.roomOf.has(userId))
          throw new GameError('already_in_room', 'Leave your room first');
        if (await this.registry.membership(userId))
          throw new GameError(
            'room_pending',
            'Your existing room is waiting for its game to finish or to reconnect',
          );
        let id: string;
        for (;;) {
          id = newRoomId();
          const reserved = await this.registry.create(id, userId);
          if (reserved === 'ok') break;
          if (reserved === 'member_taken')
            throw new GameError('room_pending', 'Already reserved in another room');
        }
        const room = new Room(this, { userId, username }, undefined, id);
        this.rooms.set(room.id, room);
        room.sync();
        return room.view();
      }
      case 'room.invite': {
        const room = this.inRoom(userId);
        const target = await findUserByUsername(this.db, m.username);
        if (!target || target.id === userId) throw new GameError('user_not_found', 'No such user');
        if (!this.friends.get(userId)?.has(target.id))
          throw new GameError('not_friends', 'You can only invite friends');
        const reserved = await this.registry.membership(target.id);
        if (reserved && reserved.instanceId !== this.registry.instanceId)
          throw new GameError(
            'room_pending',
            'That player is waiting for their existing room to finish or reconnect',
          );
        if (!this.isOnline(target.id))
          throw new GameError('not_online', `${target.username} is offline`);
        if (this.draining) throw new GameError('server_draining', 'The server is restarting');
        room.invite(userId, { userId: target.id, username: target.username });
        return undefined;
      }
      case 'room.join': {
        const room = this.rooms.get(m.roomId);
        if (!room) throw new GameError('no_invite', 'That room no longer exists');
        if (this.roomOf.get(userId) === room) return room.view();
        const current = this.roomOf.get(userId);
        if (current && current.phase !== 'lobby' && current.members.get(userId)?.inGame)
          throw new GameError('already_in_room', 'Leave your game first');
        // Validate before leaving the current room.
        if (!room.invites.has(userId))
          throw new GameError('no_invite', 'No pending invite to this room');
        if (!(await this.registry.join(userId, room.id, current?.id)))
          throw new GameError('room_pending', 'Your existing room is still on the previous server');
        current?.leave(userId);
        room.join(userId, username);
        return room.view();
      }
      case 'invite.decline': {
        const room = this.rooms.get(m.roomId);
        if (!room) return undefined;
        room.decline(userId);
        return undefined;
      }
      case 'room.leave':
        this.roomOf.get(userId)?.leave(userId);
        return undefined;
      case 'room.kick':
        this.inRoom(userId).kick(userId, m.userId);
        return undefined;
      case 'room.status':
        this.inRoom(userId).setStatus(userId, m.status);
        return undefined;
      case 'room.start':
        await this.inRoom(userId).start(userId);
        return undefined;
      case 'intent': {
        const game = this.inRoom(userId).game;
        if (!game || game.id !== m.gameId) throw new GameError('not_playing', 'Not in that game');
        const result = game.intent(userId, m.intent);
        if (!result.ok) throw new GameError('intent_rejected', result.error);
        return undefined;
      }
    }
  }

  // ---------------------------------------------------------------- results

  /**
   * Credits every player of a finished run (`recordCoopRun`), including those who left early
   * (with what they had when they left), retrying a few times if the database is down.
   */
  record(roomId: string, outcome: GameOutcome): Promise<Results> {
    const players = outcome.players.map((p) => {
      const { durationS, ...stats } = p.summary.run;
      return {
        userId: p.userId,
        pokemon: { dex: p.loadout.dex, shiny: !!p.loadout.shiny },
        ...stats,
        ...(p.left ? { leftAfterS: durationS } : {}),
      };
    });
    type Recorded = Awaited<ReturnType<typeof recordCoopRun>>;
    const attempt = async (): Promise<Recorded | null> => {
      for (const delayMs of [0, 1000, 5000]) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        try {
          return await recordCoopRun(
            this.db,
            {
              startedAt: outcome.startedAt,
              endedAt: outcome.endedAt,
              durationS: outcome.durationS,
              players,
            },
            { timeZone: this.opts.timeZone },
          );
        } catch (err) {
          this.log.error({ err, roomId, gameId: outcome.gameId }, 'recording a coop run failed');
        }
      }
      return null;
    };
    const promise = attempt().then((recorded): Results => ({
      gameId: outcome.gameId,
      runId: recorded?.runId ?? null,
      credited: recorded !== null,
      reason: outcome.reason,
      players: outcome.players.map((p) => {
        const achievements = recorded?.achievements.get(p.userId);
        return {
          userId: p.userId,
          username: p.username,
          left: p.left,
          summary: p.summary,
          ...(achievements ? { achievements } : {}),
        };
      }),
    }));
    this.records.add(promise);
    void promise.finally(() => {
      this.records.delete(promise);
      if (this.draining) this.checkDrained();
    });
    return promise;
  }

  /** Serialize adoption and lobby requests so an await never overwrites newer local changes. */
  private exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const task = this.mutationQueue.then(work);
    this.mutationQueue = task.catch(() => {});
    return task;
  }

  private background(work: () => Promise<void>): void {
    void this.exclusive(work).catch((err: unknown) =>
      this.log.error({ err }, 'room reservation update failed'),
    );
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.maintenance, ...this.adoptions]);
    await this.mutationQueue;
  }

  private runMaintenance(work: Promise<void>, finished: () => void): void {
    const task = work.catch((err: unknown) => this.log.warn({ err }, 'room maintenance failed'));
    this.maintenance.add(task);
    void task.finally(() => {
      this.maintenance.delete(task);
      finished();
    });
  }

  private async pollPendingRooms(): Promise<void> {
    for (const userId of [...this.pendingRoomNotices]) {
      if (this.stopped || this.draining) return;
      if (this.isOnline(userId) && !this.roomOf.has(userId)) await this.adoptFor(userId);
    }
  }

  memberLeft(roomId: string, userId: string): void {
    this.background(() => this.registry.leave(userId, roomId));
  }

  private async adoptFor(userId: string): Promise<void> {
    if (this.roomOf.has(userId)) return;
    const reserved = await this.registry.membership(userId);
    if (this.roomOf.has(userId) || this.stopped || this.draining || !this.isOnline(userId)) return;
    if (!reserved) {
      if (this.pendingRoomNotices.delete(userId))
        this.sessionOf(userId)?.send({ type: 'notice', code: 'room-handoff-expired' });
      return;
    }
    if (reserved.handoff) await this.adoptRoom(reserved.id);
    else if (
      reserved.instanceId !== this.registry.instanceId &&
      !this.pendingRoomNotices.has(userId)
    ) {
      this.pendingRoomNotices.add(userId);
      this.sessionOf(userId)?.send({ type: 'notice', code: 'room-handoff-pending' });
    }
  }

  private adoptRoom(id: string): Promise<void> {
    if (this.rooms.has(id) || this.draining || this.stopped) return Promise.resolve();
    const task = this.claimAndAttachRoom(id);
    this.adoptions.add(task);
    void task.then(
      () => this.adoptions.delete(task),
      () => this.adoptions.delete(task),
    );
    return task;
  }

  private async claimAndAttachRoom(id: string): Promise<void> {
    const saved = await this.registry.adopt(id);
    if (!saved) return;
    // Claiming can be slow. Only the synchronous attachment uses the local mutation queue;
    // re-check ownership/membership after the await rather than overwriting newer state.
    const attached = await this.exclusive(() => {
      if (this.draining || this.stopped) return false;
      saved.members = saved.members.filter((m) => !this.roomOf.has(m.userId));
      if (!saved.members.length) {
        this.background(() => this.registry.remove(id));
        return true;
      }
      if (!saved.members.some((m) => m.userId === saved.ownerId))
        saved.ownerId = saved.members[0]!.userId;
      const owner = saved.members.find((m) => m.userId === saved.ownerId)!;
      const room = new Room(this, owner, saved);
      this.rooms.set(id, room);
      room.restoreGrace();
      for (const m of room.members.values()) {
        this.pendingRoomNotices.delete(m.userId);
        if (this.isOnline(m.userId)) room.reconnected(m.userId);
      }
      return true;
    });
    // A signal during the claim must not consume a room without handing it onward.
    if (!attached) await this.registry.handoff(saved, this.config.restartReconnectGraceMs);
  }

  /** Publish a lobby, then detach it without a room:null message; clients keep their UI. */
  private async handoff(room: Room): Promise<void> {
    if (room.closed) return;
    room.transferring = true;
    room.cancelLoadingForHandoff();
    room.suspend();
    await this.registry.handoff(
      structuredClone(room.snapshot()),
      this.config.restartReconnectGraceMs,
    );
    const ids = [...room.members.keys()];
    room.detach();
    for (const id of ids) this.sessionOf(id)?.close(CloseCode.restarting, 'server restarting');
  }

  roomSettled(room: Room): void {
    if (!this.draining) return;
    if (!room.closed) {
      room.transferring = true;
      const task = this.exclusive(() => this.handoff(room));
      this.handoffs.add(task);
      void task
        .catch((err: unknown) => {
          this.handoffErrors.push(err);
          this.log.error({ err }, 'room handoff failed');
        })
        .finally(() => {
          this.handoffs.delete(task);
          this.checkDrained();
        });
    }
    this.checkDrained();
  }

  private busyRooms(): Room[] {
    return [...this.rooms.values()].filter((r) => r.phase !== 'lobby');
  }

  private checkDrained(): void {
    if (this.busyRooms().length || this.records.size || this.handoffs.size) return;
    for (const waiter of this.settledWaiters.splice(0)) waiter();
  }

  /** Running games retain main's drain: ticks, inputs, choices and ordinary disconnect grace. */
  async drain(timeoutMs = this.config.drainTimeoutMs): Promise<void> {
    if (!this.draining) {
      this.draining = true;
      this.drainDeadline = Date.now() + timeoutMs;
      for (const room of this.rooms.values())
        if (room.phase === 'lobby' || room.phase === 'loading') {
          room.transferring = true;
          room.suspend();
        }
      for (const session of this.sessions.values())
        session.send({ type: 'notice', code: 'server-draining', deadline: this.drainDeadline });
      // Already-running requests finish first; guards prevent new lobby mutations.
      await Promise.allSettled([...this.requests, ...this.adoptions]);
      await this.exclusive(async () => {
        for (const room of [...this.rooms.values()])
          if (room.phase === 'lobby' || room.phase === 'loading') await this.handoff(room);
      });
      for (const session of [...this.sessions.values()])
        if (!this.roomOf.has(session.userId))
          session.close(CloseCode.restarting, 'server restarting');
    }
    const settled = new Promise<void>((resolve) => this.settledWaiters.push(resolve));
    this.checkDrained();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>(
        (resolve) =>
          (timer = setTimeout(
            () => resolve(true),
            Math.max(0, (this.drainDeadline ?? Date.now()) - Date.now()),
          )),
      ),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.log.warn({ rooms: this.busyRooms().length }, 'drain timed out; ending running games');
      for (const room of this.busyRooms()) room.game?.forceEnd('server-shutdown');
    }
    await Promise.allSettled([...this.records]);
    await Promise.all([...this.handoffs]);
    await this.mutationQueue;
    if (this.handoffErrors.length) throw this.handoffErrors[0];
    this.close();
  }

  close(): void {
    this.stopped = true;
    this.ticker.stop();
    clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) room.suspend();
    for (const session of [...this.sessions.values()])
      session.close(CloseCode.restarting, 'server restarting');
  }
}
