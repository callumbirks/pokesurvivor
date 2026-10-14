import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION } from '@pokesurvivor/protocol';
import { TICK_HZ } from '@pokesurvivor/sim';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './auth/routes.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { DEFAULT_ECONOMY } from './economy/config.js';
import type { EconomyConfig } from './economy/config.js';
import { offlinePresence, silentNotifier } from './friends/presence.js';
import type { FriendNotifier, PresenceSource } from './friends/presence.js';
import { friendRoutes } from './friends/routes.js';
import { gachaRoutes } from './gacha/routes.js';
import { GameServer } from './game/server.js';
import type { GameServerOptions } from './game/server.js';
import { registerErrorHandler } from './http/errors.js';
import { missionRoutes } from './progress/routes.js';
import { runRoutes } from './runs/routes.js';
import { RunSweeper } from './runs/sweeper.js';
import { saveRoutes } from './saves/routes.js';

export interface AppOptions {
  config: Config;
  /** Without it, only health, info, the WebSocket and static files are served. */
  db?: Db;
  economy?: EconomyConfig;
  /** Live presence for the friends list; the WebSocket server provides it (phase 3c). */
  presence?: PresenceSource;
  /** Pushes friend changes to online users; the WebSocket server provides it (phase 3c). */
  friendNotifier?: FriendNotifier;
  /** Tests: sim debug flags for every coop game. */
  simDebug?: GameServerOptions['simDebug'];
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The WebSocket game server (null without a database: nobody can log in). */
    game: GameServer | null;
    /** Credits solo runs whose final report never came (null without a database). */
    runSweeper: RunSweeper | null;
  }
}

export async function buildApp({
  config,
  db,
  economy = DEFAULT_ECONOMY,
  presence,
  friendNotifier,
  simDebug,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Dokploy puts Traefik in front of us.
    trustProxy: true,
  });
  registerErrorHandler(app);
  await app.register(fastifyCookie);
  // Limits are opted into per route (`config.rateLimit`).
  await app.register(fastifyRateLimit, { global: false });

  // Health checks hit this every few seconds; keep them out of the request log.
  app.get('/healthz', { logLevel: 'warn' }, async () => {
    let database: 'up' | 'down' | 'disabled' = 'disabled';
    if (db) {
      try {
        await db.ping();
        database = 'up';
      } catch (err) {
        app.log.warn({ err }, 'healthz: database ping failed');
        database = 'down';
      }
    }
    // Always 200 while the process is alive, so a Postgres restart doesn't restart the app too.
    return { status: 'ok', database };
  });

  app.get('/api/info', () => ({ protocolVersion: PROTOCOL_VERSION, tickHz: TICK_HZ }));

  const game = db
    ? new GameServer({
        db: db.db,
        config: config.game,
        log: app.log.child({ module: 'game' }),
        timeZone: config.leaderboardTimeZone,
        simDebug,
      })
    : null;
  app.decorate('game', game);
  app.addHook('onRequest', async (_request, reply) => {
    if (game?.draining)
      return reply
        .code(503)
        .header('retry-after', '1')
        .send({
          error: { code: 'server_draining', message: 'The server is restarting' },
        });
  });

  const runSweeper = db
    ? new RunSweeper({
        db: db.db,
        log: app.log.child({ module: 'runs' }),
        timeZone: config.leaderboardTimeZone,
        ...config.soloRuns,
      })
    : null;
  app.decorate('runSweeper', runSweeper);
  app.addHook('onReady', async () => {
    await game?.restore();
    runSweeper?.start();
  });
  app.addHook('preClose', async () => runSweeper?.stop());
  // Sockets close before Fastify waits for connections to end.
  app.addHook('preClose', () => game?.close());

  if (db) {
    const common = { db: db.db, secureCookies: config.secureCookies };
    authRoutes(app, {
      ...common,
      startingCoins: economy.startingCoins,
      rateLimit: config.rateLimits.auth,
    });
    saveRoutes(app, { ...common, economy });
    runRoutes(app, {
      ...common,
      runCaps: economy.runCaps,
      leaderboardTimeZone: config.leaderboardTimeZone,
      rateLimit: config.rateLimits.actions,
      inRoom: (userId) => game?.roomOfUser(userId) != null,
    });
    gachaRoutes(app, { ...common, rateLimit: config.rateLimits.actions });
    missionRoutes(app, { ...common, timeZone: config.leaderboardTimeZone });
    friendRoutes(app, {
      ...common,
      presence: presence ?? game ?? offlinePresence,
      notifier: friendNotifier ?? game ?? silentNotifier,
      rateLimit: config.rateLimits.actions,
    });
  }

  // Client messages are small (inputs, intents, lobby requests); anything bigger is refused.
  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES } });
  game?.register(app);

  const spritesDir = join(config.assetsDir, 'pokemon');
  if (existsSync(spritesDir)) {
    // Sprite sheets never change in place: the manifest in @pokesurvivor/data carries a content
    // hash per Pokémon that clients append as a query string to bust the cache.
    await app.register(fastifyStatic, {
      root: spritesDir,
      prefix: '/sprites/',
      decorateReply: false,
      maxAge: '365d',
      immutable: true,
    });
  }

  if (existsSync(config.clientDir)) {
    await app.register(fastifyStatic, {
      root: config.clientDir,
      prefix: '/',
      setHeaders(reply, path) {
        // Vite fingerprints everything under assets/; the HTML must always be revalidated.
        reply.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  return app;
}
