// NetClient: one WebSocket to the game server, kept open with heartbeats and reconnected with
// backoff, plus the typed lobby/room API. While a game runs, `room` (a NetRoomConnection) gets
// the snapshots. Works in the browser (global WebSocket) and in Node (pass `createSocket`, e.g.
// the `ws` package with a cookie header, for bots).
import {
  CloseCode,
  FINAL_CLOSE_CODES,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ErrorInfo,
  type MemberStatus,
  type NoticeCode,
  type PresenceStatus,
  type RoomView,
  type FriendEventName,
  type FriendActivity,
  type FriendPresence,
  type SoloClock,
} from '@pokesurvivor/protocol';
import type { Intent } from '@pokesurvivor/sim';
import { Emitter } from './emitter.js';
import { timers } from './timers.js';
import { NetRoomConnection, type RoomMessage } from './room.js';
import type { SnapshotBufferOptions } from './buffer.js';
import type { Snapshot } from './snapshot.js';
import type { Game, Request, Results, ServerMsg } from './types.js';

/** The subset of the WebSocket API used (browser `WebSocket` and the `ws` package both fit). */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;

export type ConnectionState =
  /** First connection attempt. */
  | 'connecting'
  /** Connected and welcomed. */
  | 'open'
  /** Lost the connection; trying again with backoff. */
  | 'reconnecting'
  /** `close()` was called. */
  | 'closed'
  /** The server refused us for good (not logged in, superseded, wrong version): see `failure`. */
  | 'failed';

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Invite {
  roomId: string;
  from: string;
  expiresAt: number;
}

export interface ClientEvents extends Record<string, unknown> {
  state: ConnectionState;
  /** `build` and `version`: the server's deployed build (absent in development). */
  welcome: {
    userId: string;
    username: string;
    draining: boolean;
    build?: string;
    version?: string;
  };
  room: RoomView | null;
  invite: Invite;
  'invite.revoked': { roomId: string };
  'invite.declined': { roomId: string; username: string };
  presence: ReadonlyMap<string, PresenceStatus>;
  friend: { event: FriendEventName; username: string };
  /** `deadline`: in `Date.now()` time (converted from the server's clock). */
  notice: { code: NoticeCode; usernames?: string[]; deadline?: number };
  /** A game is loading; load what `game` needs, then call `room.loaded()`. */
  loading: { room: NetRoomConnection; game: Game; deadline: number };
  start: { room: NetRoomConnection; game: Game; resumed: boolean };
  snapshot: Snapshot;
  results: Results;
  error: ErrorInfo;
  /** A round-trip time sample (ms), on each pong. */
  rtt: number;
  /** The server's game loop fell behind (`server.lag`; in a running game, at most 1/s). */
  lag: { late: number; skipped: number; worstMs: number };
  /** How many players are online (`online`; after welcome, then when it changes). */
  online: number;
}

export interface NetClientOptions {
  url: string;
  createSocket?: SocketFactory;
  /** Clock for RTT and snapshot timing (ms). */
  now?: () => number;
  /** First reconnect delay; doubles up to `maxBackoffMs` (each with ±25% jitter). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Give a redeploy time to return before offering a manual reload. Default three minutes. */
  reconnectTimeoutMs?: number;
  /** Ack loading as soon as a game loads (bots, debug views with nothing to load). */
  autoLoad?: boolean;
  buffer?: SnapshotBufferOptions;
  /** Don't connect in the constructor. */
  manual?: boolean;
}

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
}

/** Rolling counters for the HUD. */
class Rate {
  private samples: { at: number; n: number }[] = [];
  constructor(private readonly windowMs = 2000) {}
  add(at: number, n = 1): void {
    this.samples.push({ at, n });
  }
  perSecond(now: number): number {
    while (this.samples[0] && this.samples[0].at < now - this.windowMs) this.samples.shift();
    return (this.samples.reduce((a, s) => a + s.n, 0) * 1000) / this.windowMs;
  }
}

export class NetClient {
  state: ConnectionState = 'connecting';
  /** Why the server refused us (state `failed`). */
  failure: { code: number; reason: string } | null = null;
  user: { id: string; username: string } | null = null;
  rttMs: number | null = null;
  /** The server is stopping (an update): no new rooms or games. */
  draining = false;
  /** When it stops (`Date.now()` time), from its `server-update` notice; null: not stopping. */
  updateAt: number | null = null;
  /** Players online, from the server's last `online` message; null until one arrives. */
  onlineCount: number | null = null;
  /** The server's clock minus ours (from `welcome`): notice deadlines are converted with it. */
  private serverSkewMs = 0;
  roomView: RoomView | null = null;
  /** The running (or loading) game, if any. */
  room: NetRoomConnection | null = null;
  readonly invites = new Map<string, Invite>();
  readonly friends = new Map<string, PresenceStatus>();
  /**
   * What each online friend is doing, and when it arrived (`now()`): a run's clock ticks on from
   * `elapsedS` at `at` unless paused. Absent: offline, or an older server.
   */
  readonly activities = new Map<string, { activity: FriendActivity; at: number }>();
  /** This client's solo run clock (`setSoloClock`), re-sent after a reconnect. */
  private soloClock: { clock: SoloClock; at: number } | null = null;

  private readonly opts: Required<Omit<NetClientOptions, 'buffer' | 'createSocket'>> &
    Pick<NetClientOptions, 'buffer' | 'createSocket'>;
  private readonly emitter = new Emitter<ClientEvents>();
  private socket: SocketLike | null = null;
  private attempt = 0;
  private nextRid = 1;
  private pending = new Map<number, Pending>();
  private heartbeatMs = 2000;
  private pingTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private retryDeadlineTimer: unknown = null;
  private connectTimer: unknown = null;
  private lastHeard = 0;
  private nextPingId = 1;
  private readonly snapshotRate = new Rate();
  private readonly byteRate = new Rate();
  private readonly inputRate = new Rate();

  constructor(options: NetClientOptions) {
    this.opts = {
      now: () => Date.now(),
      minBackoffMs: 500,
      maxBackoffMs: 10_000,
      reconnectTimeoutMs: 180_000,
      autoLoad: false,
      manual: false,
      ...options,
    };
    if (!this.opts.manual) this.connect();
  }

  on<K extends keyof ClientEvents>(event: K, handler: (payload: ClientEvents[K]) => void) {
    return this.emitter.on(event, handler);
  }

  next<K extends keyof ClientEvents>(
    event: K,
    filter?: (payload: ClientEvents[K]) => boolean,
  ): Promise<ClientEvents[K]> {
    return this.emitter.next(event, filter);
  }

  /** RTT, snapshots and bytes per second received, and inputs per second sent. */
  stats(): {
    rttMs: number | null;
    snapshotsPerSecond: number;
    bytesPerSecond: number;
    inputsPerSecond: number;
  } {
    const now = this.opts.now();
    return {
      rttMs: this.rttMs,
      snapshotsPerSecond: this.snapshotRate.perSecond(now),
      bytesPerSecond: this.byteRate.perSecond(now),
      inputsPerSecond: this.inputRate.perSecond(now),
    };
  }

  // ---------------------------------------------------------------- lobby API

  createRoom(): Promise<RoomView> {
    return this.request({ type: 'room.create' }) as Promise<RoomView>;
  }
  /** Invites an online friend (they get an `invite`). */
  invite(username: string): Promise<void> {
    return this.request({ type: 'room.invite', username }).then(() => undefined);
  }
  /** Accepts an invite: joins that room. */
  async join(roomId: string): Promise<RoomView> {
    const room = (await this.request({ type: 'room.join', roomId })) as RoomView;
    this.invites.delete(roomId);
    return room;
  }
  declineInvite(roomId: string): Promise<void> {
    this.invites.delete(roomId);
    return this.request({ type: 'invite.decline', roomId }).then(() => undefined);
  }
  leaveRoom(): Promise<void> {
    return this.request({ type: 'room.leave' }).then(() => undefined);
  }
  kick(userId: string): Promise<void> {
    return this.request({ type: 'room.kick', userId }).then(() => undefined);
  }
  /** `busy` while in the gacha, shop, collection or settings; the owner can only start when all are ready. */
  setStatus(status: MemberStatus): Promise<void> {
    return this.request({ type: 'room.status', status }).then(() => undefined);
  }
  start(): Promise<void> {
    return this.request({ type: 'room.start' }).then(() => undefined);
  }

  /**
   * Your solo run's clock, for your friends' presence: call it as the run starts, pauses and
   * resumes (and now and then to correct drift), and with null when it's over. It is sent again
   * after a reconnect, moved on by the time since.
   */
  setSoloClock(clock: SoloClock | null): void {
    this.soloClock = clock && { clock, at: this.opts.now() };
    this.sendSoloClock();
  }

  private sendSoloClock(): void {
    const c = this.soloClock;
    if (!c) {
      this.sendRaw({ type: 'activity', solo: null });
      return;
    }
    const since = c.clock.paused ? 0 : (this.opts.now() - c.at) / 1000;
    this.sendRaw({ type: 'activity', solo: { ...c.clock, elapsedS: c.clock.elapsedS + since } });
  }

  /** Sends a request and resolves with its reply's data (rejects with a `RequestError`). */
  request(message: Request): Promise<unknown> {
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      if (!this.sendRaw({ ...message, rid })) {
        reject(new RequestError('disconnected', 'Not connected'));
        return;
      }
      this.pending.set(rid, { resolve, reject });
    });
  }

  // ---------------------------------------------------------------- connection

  connect(): void {
    if (this.socket) return;
    timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const factory: SocketFactory =
      this.opts.createSocket ??
      ((url) => {
        const WS = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
        if (!WS) throw new Error('No WebSocket available: pass createSocket');
        return new WS(url);
      });
    const socket = factory(this.opts.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    // An upgrade or hello that never completes must not stop retries indefinitely.
    this.connectTimer = timers.setTimeout(() => {
      if (this.socket === socket && this.state !== 'open') this.dropConnection();
    }, 10_000);
    socket.onopen = () => {
      this.lastHeard = this.opts.now();
      socket.send(encode({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.receive(ev.data);
    };
    socket.onclose = (ev) => {
      if (this.socket === socket) this.closed(ev.code, ev.reason);
    };
    socket.onerror = () => {};
  }

  /** Closes for good (no reconnect). */
  close(): void {
    this.setState('closed');
    const socket = this.socket;
    this.closed(1000, 'client closed');
    socket?.close(1000, 'client closed');
  }

  /** Testing aid: drop the socket as if the network failed (the client will reconnect). */
  dropConnection(): void {
    const socket = this.socket;
    if (!socket) return;
    this.closed(4000, 'dropped');
    socket.close(4000, 'dropped');
  }

  private sendRaw(message: object): boolean {
    if (!this.socket || this.socket.readyState !== OPEN || this.state !== 'open') return false;
    this.socket.send(encode(message));
    return true;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitter.emit('state', state);
  }

  private closed(code: number, reason: string): void {
    timers.clearTimeout(this.connectTimer);
    this.connectTimer = null;
    timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket = null;
    this.rttMs = null;
    for (const p of this.pending.values())
      p.reject(new RequestError('disconnected', 'Connection lost'));
    this.pending.clear();
    this.room?.handleDisconnect();
    if (this.state === 'closed' || this.state === 'failed') {
      timers.clearTimeout(this.retryDeadlineTimer);
      this.retryDeadlineTimer = null;
      return;
    }
    if (FINAL_CLOSE_CODES.includes(code)) {
      this.failure = { code, reason };
      this.setState('failed');
      timers.clearTimeout(this.retryDeadlineTimer);
      this.retryDeadlineTimer = null;
      return;
    }
    if (this.retryDeadlineTimer === null)
      this.retryDeadlineTimer = timers.setTimeout(() => {
        this.failure = { code: CloseCode.timeout, reason: 'Reconnect timed out; reload the page' };
        this.setState('failed');
        const socket = this.socket;
        this.closed(1000, 'reconnect timed out');
        socket?.close(1000, 'reconnect timed out');
      }, this.opts.reconnectTimeoutMs);
    this.setState('reconnecting');
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** this.attempt++);
    const delay = base * (0.75 + Math.random() * 0.5);
    this.reconnectTimer = timers.setTimeout(() => this.connect(), delay);
  }

  private heartbeat(): void {
    const now = this.opts.now();
    // Nothing heard for a while: the socket is dead even if it doesn't know it yet.
    if (now - this.lastHeard > this.heartbeatMs * 3) {
      this.dropConnection();
      return;
    }
    this.sendRaw({ type: 'ping', id: this.nextPingId++, sentAt: now });
  }

  private receive(data: unknown): void {
    const now = this.opts.now();
    this.lastHeard = now;
    if (typeof data !== 'string') {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null;
      if (!bytes) return;
      this.byteRate.add(now, bytes.length);
      const snap = this.room?.handleFrame(bytes, now);
      if (snap) {
        this.snapshotRate.add(now);
        this.emitter.emit('snapshot', snap);
      }
      return;
    }
    this.byteRate.add(now, data.length);
    const m = decodeServerMessage(data) as ServerMsg | null;
    if (m) this.handle(m, now);
  }

  private setPresence(f: FriendPresence, now: number): void {
    this.friends.set(f.username, f.status);
    if (f.activity && f.status !== 'offline')
      this.activities.set(f.username, { activity: f.activity, at: now });
    else this.activities.delete(f.username);
  }

  private handle(m: ServerMsg, now: number): void {
    switch (m.type) {
      case 'welcome':
        timers.clearTimeout(this.connectTimer);
        this.connectTimer = null;
        timers.clearTimeout(this.retryDeadlineTimer);
        this.retryDeadlineTimer = null;
        this.attempt = 0;
        this.failure = null;
        this.user = { id: m.userId, username: m.username };
        this.draining = m.draining;
        if (!m.draining) this.updateAt = null;
        this.serverSkewMs = m.serverTime - Date.now();
        this.heartbeatMs = m.heartbeatMs;
        timers.clearInterval(this.pingTimer);
        this.pingTimer = timers.setInterval(() => this.heartbeat(), this.heartbeatMs);
        this.setState('open');
        this.heartbeat();
        if (this.soloClock) this.sendSoloClock();
        this.emitter.emit('welcome', {
          userId: m.userId,
          username: m.username,
          draining: m.draining,
          build: m.build,
          version: m.version,
        });
        return;
      case 'pong':
        this.rttMs = now - m.sentAt;
        this.emitter.emit('rtt', this.rttMs);
        return;
      case 'server.lag':
        this.emitter.emit('lag', { late: m.late, skipped: m.skipped, worstMs: m.worstMs });
        return;
      case 'online':
        this.onlineCount = m.count;
        this.emitter.emit('online', m.count);
        return;
      case 'reply': {
        const p = this.pending.get(m.rid);
        if (!p) return;
        this.pending.delete(m.rid);
        if (m.ok) p.resolve(m.data);
        else p.reject(new RequestError(m.error.code, m.error.message));
        return;
      }
      case 'error':
        if (m.error.code === 'version_mismatch')
          this.failure = { code: CloseCode.versionMismatch, reason: m.error.message };
        this.emitter.emit('error', m.error);
        return;
      case 'room':
        this.roomView = m.room;
        // Not (or no longer) playing in this room's game: dropped at loading, left, or it ended.
        if (!m.room?.members.find((x) => x.userId === this.user?.id)?.inGame) this.leftGame();
        this.emitter.emit('room', m.room);
        return;
      case 'invite':
        this.invites.set(m.roomId, { roomId: m.roomId, from: m.from, expiresAt: m.expiresAt });
        this.emitter.emit('invite', { roomId: m.roomId, from: m.from, expiresAt: m.expiresAt });
        return;
      case 'invite.revoked':
        this.invites.delete(m.roomId);
        this.emitter.emit('invite.revoked', { roomId: m.roomId });
        return;
      case 'invite.declined':
        this.emitter.emit('invite.declined', { roomId: m.roomId, username: m.username });
        return;
      case 'presence':
        this.friends.clear();
        this.activities.clear();
        for (const f of m.friends) this.setPresence(f, now);
        this.emitter.emit('presence', this.friends);
        return;
      case 'presence.update':
        this.setPresence(m, now);
        this.emitter.emit('presence', this.friends);
        return;
      case 'friend':
        this.emitter.emit('friend', { event: m.event, username: m.username });
        return;
      case 'notice': {
        // Deadlines are the server's clock: ours from here on.
        const deadline = m.deadline === undefined ? undefined : m.deadline - this.serverSkewMs;
        if (m.code === 'server-draining' || m.code === 'server-update') this.draining = true;
        if (m.code === 'server-update' && deadline !== undefined) this.updateAt = deadline;
        this.emitter.emit('notice', { code: m.code, usernames: m.usernames, deadline });
        return;
      }
      case 'game.loading': {
        const room = this.roomFor(m.game);
        room.handleLoading(m.game);
        this.emitter.emit('loading', { room, game: m.game, deadline: m.deadline });
        if (this.opts.autoLoad) room.loaded();
        return;
      }
      case 'game.start': {
        const room = this.roomFor(m.game);
        room.handleStart(m.game, m.resumed);
        this.emitter.emit('start', { room, game: m.game, resumed: m.resumed });
        return;
      }
      case 'game.results':
        this.room?.handleResults(m.results);
        this.emitter.emit('results', m.results);
        return;
    }
  }

  private roomFor(game: Game): NetRoomConnection {
    if (this.room?.game?.gameId === game.gameId) return this.room;
    if (!this.user) throw new Error('game message before welcome');
    this.room = new NetRoomConnection(
      this.user.id,
      {
        send: (message: RoomMessage) => {
          const sent = this.sendRaw(message);
          if (sent && message.type === 'input') this.inputRate.add(this.opts.now());
          return sent;
        },
        request: (message: { type: 'intent'; gameId: string; intent: Intent }) =>
          this.request(message),
        now: () => this.opts.now(),
      },
      this.opts.buffer,
    );
    return this.room;
  }

  private leftGame(): void {
    if (this.room && this.room.phase !== 'ended') this.room.setPhase('ended');
  }
}

/** The game server's WebSocket URL for a page at `location` (same origin, ws/wss to match). */
export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}
