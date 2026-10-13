import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { PROTOCOL_VERSION, decodeClientMessage, encode } from '@pokesurvivor/protocol';
import { TICK_HZ } from '@pokesurvivor/sim';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';

export interface AppOptions {
  config: Config;
  /** Absent in tests that don't need Postgres. */
  db?: Pick<Db, 'ping'>;
}

export async function buildApp({ config, db }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Dokploy puts Traefik in front of us.
    trustProxy: true,
  });

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
