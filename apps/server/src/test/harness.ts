import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import postgres from 'postgres';
import { buildApp } from '../app.js';
import { isOffensiveUsername } from '../auth/profanity.js';
import type { AppOptions } from '../app.js';
import { loadConfig } from '../config.js';
import { createDb, runMigrations } from '../db/index.js';
import type { Db } from '../db/index.js';
import { DEFAULT_ECONOMY } from '../economy/config.js';
import type { EconomyConfig } from '../economy/config.js';
import { withLockedSave } from '../saves/service.js';

/**
 * Integration tests run against real Postgres: `DATABASE_URL` (docker compose locally, the
 * service container in CI). Each test file gets its own freshly migrated database, dropped
 * afterwards, so files can run in parallel and never touch dev data.
 */
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://pokesurvivor:pokesurvivor@localhost:5432/pokesurvivor';

export interface TestDatabase {
  url: string;
  db: Db;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), new URL('../../drizzle', import.meta.url).pathname);
  const db = createDb(url.toString());
  return {
    url: url.toString(),
    db,
    async drop() {
      await db.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

export interface TestAppOptions {
  env?: Record<string, string>;
  /**
   * Run on this database instead of a fresh one (it is not dropped on close): to test a server
   * restart, close one app and build another on the same database.
   */
  database?: TestDatabase;
  economy?: Partial<EconomyConfig>;
  presence?: AppOptions['presence'];
  friendNotifier?: AppOptions['friendNotifier'];
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
  /** A client that keeps the session cookie between requests, like a browser. */
  client(): TestClient;
  /** Registers a new user and returns a logged-in client for it. */
  newUser(username?: string): Promise<TestClient & { username: string; userId: string }>;
}

let userCounter = 0;
export function uniqueUsername(prefix = 'user'): string {
  for (;;) {
    userCounter += 1;
    const name = `${prefix}_${userCounter}_${randomBytes(2).toString('hex')}`.slice(0, 16);
    // The hex suffix can spell a word in leetspeak (`a55`), which registration would reject.
    if (!isOffensiveUsername(name)) return name;
  }
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const database = options.database ?? (await createTestDatabase());
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    // Tests make many logins from one address; the rate-limit test lowers these again.
    AUTH_RATE_LIMIT_MAX: '10000',
    ACTION_RATE_LIMIT_MAX: '10000',
    CLIENT_DIR: '/nonexistent',
    ...options.env,
  });
  const app = await buildApp({
    config,
    db: database.db,
    economy: { ...DEFAULT_ECONOMY, ...options.economy },
    presence: options.presence,
    friendNotifier: options.friendNotifier,
  });
  await app.ready();

  const client = () => new TestClient(app);
  return {
    app,
    db: database.db,
    client,
    async close() {
      await app.close();
      if (!options.database) await database.drop();
    },
    async newUser(username = uniqueUsername()) {
      const c = client();
      const res = await c.post('/api/auth/register', { username, password: 'correct horse' });
      if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
      const { user } = res.json<{ user: { id: string } }>();
      return Object.assign(c, { username, userId: user.id });
    },
  };
}

export class TestClient {
  cookie: string | undefined;

  constructor(private readonly app: FastifyInstance) {}

  async request(options: InjectOptions): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      ...options,
      headers: { ...options.headers, ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    for (const c of res.cookies) {
      // A cookie with an expiry in the past (logout) deletes it.
      const expired = !c.value || (c.expires !== undefined && c.expires.getTime() <= Date.now());
      this.cookie = expired ? undefined : `${c.name}=${c.value}`;
    }
    return res;
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
  post(url: string, payload?: object) {
    return this.request({ method: 'POST', url, ...(payload ? { payload } : {}) });
  }
  put(url: string, payload: object) {
    return this.request({ method: 'PUT', url, payload });
  }
  patch(url: string, payload: object) {
    return this.request({ method: 'PATCH', url, payload });
  }
  delete(url: string) {
    return this.request({ method: 'DELETE', url });
  }
}

/** Gives a user Pokémon directly, skipping the starter, gacha and achievements. */
export async function grantPokemon(
  db: Db,
  userId: string,
  pokemon: { dex: number; shiny?: boolean }[],
): Promise<void> {
  await withLockedSave(db.db, userId, (save) => {
    for (const { dex, shiny } of pokemon) {
      save.data.owned[String(dex)] ??= { at: Date.now(), from: 'gacha' };
      if (shiny) save.data.shiny[String(dex)] ??= { at: Date.now(), from: 'gacha' };
    }
  });
}

/** Credits gems to a save (an `admin_adjustment`): runs are the only real source. */
export async function grantGems(db: Db, userId: string, gems: number): Promise<void> {
  await withLockedSave(db.db, userId, (save) => {
    save.wallet.credit('gems', gems, 'admin_adjustment', 'test');
  });
}
