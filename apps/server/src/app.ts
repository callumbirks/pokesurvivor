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

/** The deployed build's id and version label, on every `/api/` response (absent in development). */
export const BUILD_HEADER = 'x-build';
export const VERSION_HEADER = 'x-build-version';

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
  let closing = false;
  app.addHook('preClose', (done) => {
    closing = true;
    done();
  });
  registerErrorHandler(app);
  // Errors are never cacheable. Without this, Cloudflare gives a 404 its Browser Cache TTL
  // (`max-age=14400`): during a deploy's overlap a new index.html can get a 404 from the old
  // container for a new hashed asset, and browsers kept that 404 (a blank page until a
  // hard refresh). Cloudflare doesn't override `no-store`.
  app.addHook('onSend', async (_req, reply) => {
    if (reply.statusCode >= 400) reply.header('cache-control', 'no-store');
  });
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

  const build = config.game.build;
  app.get('/api/info', () => ({
    protocolVersion: PROTOCOL_VERSION,
    tickHz: TICK_HZ,
    ...(build ? { build: build.id, version: build.version } : {}),
  }));
  // Every API response names the deployed build, so a client notices a deploy on its next call
  // too, not only when its WebSocket reconnects.
  if (build)
    app.addHook('onSend', async (req, reply) => {
      // Not while stopping for an update: this build is the old one.
      if (req.url.startsWith('/api/') && !app.game?.draining) {
        reply.header(BUILD_HEADER, build.id);
        reply.header(VERSION_HEADER, build.version);
      }
    });

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

  const runSweeper = db
    ? new RunSweeper({
        db: db.db,
        log: app.log.child({ module: 'runs' }),
        timeZone: config.leaderboardTimeZone,
        ...config.soloRuns,
        onCredited: (ids) => game?.soloRunsClosed(ids),
      })
    : null;
  app.decorate('runSweeper', runSweeper);
  app.addHook('onReady', async () => {
    await game?.registry.cleanup();
    // Games the previous server saved on its way down, before any player can connect.
    await game?.restoreGames();
    runSweeper?.start();
  });
  app.addHook('preClose', async () => runSweeper?.stop());
  // Sockets close before Fastify waits for connections to end.
  app.addHook('preClose', async () => {
    game?.close();
    await game?.flush();
  });

  if (db) {
    const common = { db: db.db, secureCookies: config.secureCookies };
    authRoutes(app, {
      ...common,
      startingCoins: economy.startingCoins,
      rateLimit: config.rateLimits.auth,
    });
    saveRoutes(app, {
      ...common,
      economy,
      onPartnerChanged: (userId) => game?.partnerChanged(userId),
    });
    runRoutes(app, {
      ...common,
      runCaps: economy.runCaps,
      leaderboardTimeZone: config.leaderboardTimeZone,
      rateLimit: config.rateLimits.actions,
      inRoom: async (userId) =>
        game?.roomOfUser(userId) != null || !!(await game?.registry.membership(userId)),
      runClosed: (userId, runId) => game?.soloRunsClosed([runId], userId),
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
  // Fastify's shutdown 503 bypasses onResponse, where the WebSocket plugin normally
  // destroys rejected upgrade sockets. End these raw connections ourselves: they
  // aren't tracked WebSockets, and a half-closed peer can otherwise block app.close().
  app.server.on('upgrade', (_request, socket) => {
    if (closing) socket.destroy();
  });
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
