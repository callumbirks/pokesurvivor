// Headless bot clients for the game server tests: real WebSockets (the `ws` package) to a real
// server on a random port, driven by @pokesurvivor/netclient, with injectable latency and jitter
// (delivery stays in order, as over TCP), forced disconnects and offline periods.
import { NetClient, firstOption, type SocketLike } from '@pokesurvivor/netclient';
import type { Snapshot } from '@pokesurvivor/netclient';
import type { MoveInput } from '@pokesurvivor/sim';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import WebSocket from 'ws';
import { buildApp } from '../app.js';
import type { AppOptions } from '../app.js';
import { loadConfig } from '../config.js';
import type { GameConfig } from '../config.js';
import { friendships } from '../db/schema.js';
import type { GameServer } from '../game/server.js';
import { withLockedSave } from '../saves/service.js';
import { createTestDatabase, uniqueUsername } from './harness.js';
import type { TestDatabase } from './harness.js';

export interface NetConditions {
  /** One-way delay added to every message, both directions. */
  latencyMs: number;
  /** Extra random delay up to this much (order is kept). */
  jitterMs: number;
  /** While true, connection attempts fail (the bot is "offline"). */
  offline: boolean;
}

/**
 * Delivers callbacks after a delay, strictly in the order they were queued (one timer for the
 * head of the queue: separate timers per message can fire out of order in Node).
 */
class DelayLine {
  private queue: { at: number; fn: () => void }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private last = 0;

  push(delayMs: number, fn: () => void): void {
    this.last = Math.max(this.last, Date.now() + delayMs);
    this.queue.push({ at: this.last, fn });
    if (!this.timer) this.arm();
  }

  private arm(): void {
    const head = this.queue[0];
    if (!head) return;
    this.timer = setTimeout(() => this.pump(), Math.max(0, head.at - Date.now()));
  }

  private pump(): void {
    this.timer = null;
    const now = Date.now();
    while (this.queue[0] && this.queue[0].at <= now) this.queue.shift()!.fn();
    this.arm();
  }
}

/** A `SocketLike` over `ws` that delays delivery in both directions, keeping order. */
class LaggySocket implements SocketLike {
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly incoming = new DelayLine();
  private readonly outgoing = new DelayLine();
  private closedLocally = false;
  readonly ws: WebSocket | null;

  constructor(
    url: string,
    cookie: string,
    private readonly net: NetConditions,
  ) {
    if (net.offline) {
      this.ws = null;
      setTimeout(() => this.onclose?.({ code: 1006, reason: 'offline' }), 5);
      return;
    }
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.on('open', () => this.deliver(() => this.onopen?.({})));
    ws.on('message', (data: ArrayBuffer | Buffer, isBinary: boolean) => {
      const payload = isBinary ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
      this.deliver(() => this.onmessage?.({ data: payload }));
    });
    ws.on('close', (code, reason) =>
      this.deliver(() => this.onclose?.({ code, reason: reason.toString() })),
    );
    ws.on('error', () => {});
  }

  get readyState(): number {
    if (this.closedLocally) return 3;
    return this.ws?.readyState ?? 3;
  }

  private delay(): number {
    return this.net.latencyMs + Math.random() * this.net.jitterMs;
  }

  private deliver(fn: () => void): void {
    this.incoming.push(this.delay(), fn);
  }

  send(data: string): void {
    this.outgoing.push(this.delay(), () => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    });
  }

  close(code?: number, reason?: string): void {
    this.closedLocally = true;
    // Custom codes are only valid 4000–4999 (and 1000).
    if (code === 4000) this.ws?.terminate();
    else this.ws?.close(code, reason);
  }
}

export interface BotOptions {
  latencyMs?: number;
  jitterMs?: number;
  /** Ack loading automatically (default true). */
  autoLoad?: boolean;
  /** Partner to play. */
  dex?: number;
}

export class Bot {
  readonly net: NetConditions;
  readonly client: NetClient;
  /** Snapshots received in the current game. */
  snapshots: Snapshot[] = [];
  private stopInputs: (() => void) | null = null;

  constructor(
    readonly username: string,
    readonly userId: string,
    readonly cookie: string,
    url: string,
    opts: BotOptions,
  ) {
    this.net = { latencyMs: opts.latencyMs ?? 0, jitterMs: opts.jitterMs ?? 0, offline: false };
    this.client = new NetClient({
      url,
      createSocket: (u) => new LaggySocket(u, cookie, this.net),
      autoLoad: opts.autoLoad ?? true,
      minBackoffMs: 50,
      maxBackoffMs: 400,
      manual: true,
    });
    this.client.on('snapshot', (s) => {
      this.snapshots.push(s);
      if (this.snapshots.length > 600) this.snapshots.splice(0, 300);
    });
    this.client.on('start', ({ resumed }) => {
      if (!resumed) this.snapshots = [];
    });
  }

  get latest(): Snapshot | null {
    return this.client.room?.latest ?? null;
  }

  async connect(): Promise<void> {
    const welcomed = this.client.next('welcome');
    this.client.connect();
    await welcomed;
  }

  /** Simulates a network failure: the socket dies; the client reconnects with backoff. */
  drop(opts: { offlineMs?: number } = {}): void {
    if (opts.offlineMs) {
      this.net.offline = true;
      setTimeout(() => (this.net.offline = false), opts.offlineMs);
    }
    this.client.dropConnection();
  }

  /**
   * Walks in a slow circle (sends inputs every tick while the game runs). `aim`: manual aim per
   * input count (radians), or null for auto-aim (the default).
   */
  wander(aim: (t: number) => number | null = () => null): void {
    this.stopInputs?.();
    const room = this.client.room;
    if (!room) return;
    let t = 0;
    this.stopInputs = room.startInputLoop((): MoveInput => {
      t++;
      return { moveX: Math.cos(t / 40), moveY: Math.sin(t / 40), aim: aim(t) };
    });
  }

  stop(): void {
    this.stopInputs?.();
    this.stopInputs = null;
  }

  /** Picks the first option of each of its pending choices, after `delayMs`. */
  autoPick(delayMs = 0): () => void {
    const handled = new Set<number>();
    return this.client.on('snapshot', (snap) => {
      for (const c of snap.choices) {
        if (handled.has(c.id)) continue;
        handled.add(c.id);
        setTimeout(() => {
          const room = this.client.room;
          if (!room) return;
          const intent = firstOption(c);
          if (intent) void room.intent(intent);
        }, delayMs);
      }
    });
  }

  /** Resolves when a snapshot matches. */
  until(match: (s: Snapshot) => boolean, timeoutMs = 10_000): Promise<Snapshot> {
    const latest = this.latest;
    if (latest && match(latest)) return Promise.resolve(latest);
    return withTimeout(
      this.client.next('snapshot', match),
      timeoutMs,
      `${this.username}: snapshot condition`,
    );
  }

  close(): void {
    this.stop();
    this.client.close();
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    }),
  ]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it returns truthy. */
export async function waitFor<T>(
  check: () => T | null | undefined | false,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

export interface GameTestServer {
  app: FastifyInstance;
  game: GameServer;
  database: TestDatabase;
  url: string;
  bot(opts?: BotOptions): Promise<Bot>;
  /** Bots that are all friends with each other, connected. */
  party(n: number, opts?: BotOptions | ((i: number) => BotOptions)): Promise<Bot[]>;
  /** Real app shutdown/rebuild, same DB and port; existing clients retry automatically. */
  restart(downtimeMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function createGameTestServer(
  game: Partial<GameConfig> = {},
  options: Pick<AppOptions, 'simDebug'> = { simDebug: { noSpawns: true, invulnerable: true } },
): Promise<GameTestServer> {
  const database = await createTestDatabase();
  const config = loadConfig({
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: database.url,
    AUTH_RATE_LIMIT_MAX: '10000',
    ACTION_RATE_LIMIT_MAX: '10000',
    CLIENT_DIR: '/nonexistent',
    ASSETS_DIR: '/nonexistent',
  });
  config.game = {
    ...config.game,
    reconnectGraceMs: 3000,
    loadingTimeoutMs: 1500,
    choiceTimeoutS: 30,
    ...game,
  };
  let app = await buildApp({ config, db: database.db, simDebug: options.simDebug });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `${address.replace('http', 'ws')}/ws`;
  const bots: Bot[] = [];

  async function bot(opts: BotOptions = {}): Promise<Bot> {
    const username = uniqueUsername('bot');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'correct horse' },
    });
    if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
    const userId = res.json<{ user: { id: string } }>().user.id;
    const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const dex = opts.dex ?? 25;
    await withLockedSave(database.db.db, userId, (save) => {
      save.data.owned[String(dex)] ??= { at: Date.now(), from: 'starter' };
      save.partner = { dex, shiny: false };
    });
    const b = new Bot(username, userId, cookie, url, opts);
    bots.push(b);
    return b;
  }

  return {
    get app() {
      return app;
    },
    get game() {
      return app.game as GameServer;
    },
    database,
    url,
    bot,
    async party(n, opts = {}) {
      const list: Bot[] = [];
      for (let i = 0; i < n; i++) list.push(await bot(typeof opts === 'function' ? opts(i) : opts));
      await makeFriends(database, list);
      await Promise.all(list.map((b) => b.connect()));
      return list;
    },
    async restart(downtimeMs = 0) {
      await app.game!.shutdown();
      await app.close();
      if (downtimeMs) await sleep(downtimeMs);
      app = await buildApp({ config, db: database.db, simDebug: options.simDebug });
      await app.listen({ host: '127.0.0.1', port: Number(new URL(address).port) });
    },
    async close() {
      for (const b of bots) b.close();
      await app.close();
      await database.drop();
    },
  };
}

/** Makes every pair of bots friends (directly in the database). */
export async function makeFriends(database: TestDatabase, bots: readonly Bot[]): Promise<void> {
  for (let i = 0; i < bots.length; i++)
    for (let j = i + 1; j < bots.length; j++)
      await database.db.db.insert(friendships).values({
        requesterId: bots[i]!.userId,
        addresseeId: bots[j]!.userId,
        status: 'accepted',
        acceptedAt: sql`now()`,
      });
}

/** The first bot creates a room and the others join it, all ready. */
export async function lobby(bots: readonly Bot[]): Promise<string> {
  const [owner, ...guests] = bots;
  if (!owner) throw new Error('no bots');
  const room = await owner.client.createRoom();
  for (const g of guests) {
    const invited = g.client.next('invite');
    await owner.client.invite(g.username);
    await withTimeout(invited, 5000, `${g.username}'s invite`);
    await g.client.join(room.id);
  }
  await Promise.all(bots.map((b) => b.client.setStatus('ready')));
  await waitFor(
    () =>
      owner.client.roomView?.members.length === bots.length &&
      owner.client.roomView.blockers.length === 0,
    'everyone ready (partners loaded)',
  );
  return room.id;
}

/** Starts the game and waits until every bot got its first snapshot. */
export async function startGame(bots: readonly Bot[]): Promise<void> {
  const started = bots.map((b) =>
    withTimeout(b.client.next('snapshot'), 10_000, `${b.username} start`),
  );
  await bots[0]!.client.start();
  await Promise.all(started);
}
