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
  type PresenceStatus,
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
import { Room } from './room.js';
import { Session } from './session.js';
import { Ticker } from './ticker.js';
import { eq, inArray } from 'drizzle-orm';
import { users, roomRestartState } from '../db/schema.js';

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
  private drainDeadline: number | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomOf = new Map<string, Room>();
  private readonly friends = new Map<string, Set<string>>();
  private readonly lastPresence = new Map<string, PresenceStatus>();
  /** Usernames of users who just went offline (their presence is still being pushed). */
  private readonly lastUsername = new Map<string, string>();
  private readonly games = new Set<Game>();
  private readonly records = new Set<Promise<unknown>>();
  private readonly ticker: Ticker;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly requests = new Set<Promise<void>>();
  private restorePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly opts: GameServerOptions) {
    this.db = opts.db;
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
    if (room) this.roomOf.set(userId, room);
    else this.roomOf.delete(userId);
  }

  removeRoom(room: Room): void {
    this.rooms.delete(room.id);
    if (room.game && room.game.phase !== 'ended') this.removeGame(room.game);
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
    if (!room) return 'online';
    const inGame = room.members.get(userId)?.inGame;
    return inGame && (room.phase === 'loading' || room.phase === 'running')
      ? 'in_game'
      : 'in_lobby';
  }

  /** Pushes the user's presence to their online friends if it changed. */
  presenceChanged(userId: string): void {
    const status = this.presenceOf(userId);
    if (this.lastPresence.get(userId) === status) return;
    if (status === 'offline') this.lastPresence.delete(userId);
    else this.lastPresence.set(userId, status);
    const username = this.usernameOf(userId);
    if (!username) return;
    for (const friendId of this.friends.get(userId) ?? [])
      this.sessionOf(friendId)?.send({ type: 'presence.update', username, status });
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
      target.send({ type: 'presence.update', username, status: this.presenceOf(otherId) });
      this.sessionOf(otherId)?.send({
        type: 'presence.update',
        username: target.username,
        status: this.presenceOf(event.userId),
      });
    }
  }

  // ---------------------------------------------------------------- sockets

  private accept(socket: WebSocket, request: FastifyRequest): void {
    if (this.draining) {
      socket.close(CloseCode.restarting, 'server restarting');
      return;
    }
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
    if (this.draining) return;
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
    void this.welcome(session);
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
    const room = this.roomOf.get(session.userId);
    if (room) room.reconnected(session.userId);
    else session.send({ type: 'room', room: null });
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
      session.send({
        type: 'presence',
        friends: ids
          .filter((id) => byId.has(id))
          .map((id) => ({ username: byId.get(id) as string, status: this.presenceOf(id) })),
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
    this.lastUsername.set(session.userId, session.username);
    this.roomOf.get(session.userId)?.disconnected(session.userId);
    this.presenceChanged(session.userId);
    this.friends.delete(session.userId);
    this.lastUsername.delete(session.userId);
  }

  private checkHeartbeats(): void {
    const deadline = Date.now() - this.config.heartbeatMs * 5;
    for (const session of this.sessions.values()) {
      if (session.lastHeard < deadline) session.close(CloseCode.timeout, 'heartbeat timeout');
    }
  }

  // ---------------------------------------------------------------- requests

  private async request(session: Session, m: ClientMessage & { rid: number }): Promise<void> {
    try {
      const data = await this.handleRequest(session, m);
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
        const room = new Room(this, { userId, username });
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
    const attempt = async (): Promise<string | null> => {
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
    const promise = attempt().then((runId): Results => ({
      gameId: outcome.gameId,
      runId,
      credited: runId !== null,
      reason: outcome.reason,
      players: outcome.players.map((p) => ({
        userId: p.userId,
        username: p.username,
        left: p.left,
        summary: p.summary,
      })),
    }));
    this.records.add(promise);
    void promise.finally(() => this.records.delete(promise));
    return promise;
  }

  // ---------------------------------------------------------------- restarts

  /** Restore before accepting any sockets. Saved state is consumed to avoid resurrecting old rooms
   * after a later ungraceful crash. This feature guarantees SIGTERM restarts, not SIGKILL. */
  restore(): Promise<void> {
    return (this.restorePromise ??= this.restoreRooms());
  }

  private async restoreRooms(): Promise<void> {
    const [saved] = await this.db.select().from(roomRestartState).where(eq(roomRestartState.id, 1));
    if (!saved) return;
    if (saved.format !== 1) throw new Error(`Unsupported room checkpoint format ${saved.format}`);
    for (const data of saved.rooms) {
      const owner = data.members.find((m) => m.userId === data.ownerId);
      if (!owner) throw new Error(`Room ${data.id} has no owner in checkpoint`);
      const room = new Room(this, owner, data);
      this.rooms.set(room.id, room);
      room.restoreGrace();
    }
    await this.db.delete(roomRestartState).where(eq(roomRestartState.id, 1));
    this.log.info({ rooms: this.rooms.size }, 'restored rooms after restart');
  }

  /** SIGTERM: reject work, freeze timers and the sim, await in-flight work, commit the
   * checkpoint, then close sockets. A failed write rejects shutdown instead of claiming success. */
  shutdown(): Promise<void> {
    return (this.shutdownPromise ??= this.saveAndClose());
  }

  private async saveAndClose(): Promise<void> {
    this.draining = true;
    this.drainDeadline = Date.now() + 30_000;
    this.ticker.stop();
    clearInterval(this.heartbeat);
    // A signal during boot must not overwrite rooms that are still being restored.
    await this.restore();
    for (const room of this.rooms.values()) room.suspend();
    for (const session of this.sessions.values())
      session.send({ type: 'notice', code: 'server-draining', deadline: this.drainDeadline });
    await Promise.allSettled([...this.requests]);
    for (const room of this.rooms.values()) room.finishForRestart();
    await Promise.allSettled([...this.records]);
    // Serialize now: no sim tick, socket callback or request can mutate this checkpoint.
    const rooms = structuredClone([...this.rooms.values()].map((r) => r.snapshot()));
    await this.db
      .insert(roomRestartState)
      .values({ id: 1, format: 1, rooms })
      .onConflictDoUpdate({ target: roomRestartState.id, set: { format: 1, rooms } });
    this.log.info({ rooms: rooms.length }, 'saved rooms for restart');
    this.close();
  }

  /** Closes sockets and stops callbacks without removing membership (also used by tests). */
  close(): void {
    this.draining = true;
    this.ticker.stop();
    clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) room.suspend();
    for (const session of [...this.sessions.values()])
      session.close(CloseCode.restarting, 'server restarting');
  }
}
