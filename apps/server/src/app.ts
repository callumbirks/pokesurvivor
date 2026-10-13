import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { PROTOCOL_VERSION, decodeClientMessage, encode } from '@pokesurvivor/protocol';
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
import { registerErrorHandler } from './http/errors.js';
import { missionRoutes } from './progress/routes.js';
import { runRoutes } from './runs/routes.js';
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
}

export async function buildApp({
  config,
  db,
  economy = DEFAULT_ECONOMY,
  presence = offlinePresence,
  friendNotifier = silentNotifier,
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
    });
    missionRoutes(app, { ...common, timeZone: config.leaderboardTimeZone });
    friendRoutes(app, {
      ...common,
      presence,
      notifier: friendNotifier,
      rateLimit: config.rateLimits.actions,
    });
  }

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = decodeClientMessage(Buffer.from(data as Buffer).toString('utf8'));
      if (message?.type === 'ping') {
        socket.send(
          encode({
            type: 'pong',
            id: message.id,
            sentAt: message.sentAt,
            serverTime: Date.now(),
            protocolVersion: PROTOCOL_VERSION,
          }),
        );
      }
    });
  });

  const spritesDir = join(config.assetsDir, 'pokemon');
  if (existsSync(spritesDir)) {
    // Sprite sheets never change in place: the manifest in @pokesurvivor/data carries a content
    // hash per Pokémon that clients append as a query string to bust the cache.
    for (const prefix of ['/sprites/', '/legacy/assets/pokemon/']) {
      await app.register(fastifyStatic, {
        root: spritesDir,
        prefix,
        decorateReply: false,
        maxAge: '365d',
        immutable: true,
      });
    }
  }

  if (existsSync(config.legacyDir)) {
    await app.register(fastifyStatic, {
      root: config.legacyDir,
      prefix: '/legacy',
      decorateReply: false,
      redirect: true,
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
