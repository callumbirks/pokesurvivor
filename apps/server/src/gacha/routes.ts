import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import type { Database } from '../db/index.js';
import { parseBody } from '../http/errors.js';
import { getSave } from '../saves/service.js';
import { gachaInfo, pullGacha } from './service.js';

export interface GachaRoutesOptions {
  db: Database;
  secureCookies: boolean;
  rateLimit: { max: number; timeWindowMs: number };
}

const pullBody = z.object({
  banner: z.string().min(1).max(32),
  count: z.number().int().positive(),
  payWith: z.enum(['tickets', 'tickets10']).default('tickets'),
});

/** The server-side gacha: the client only shows the banners and animates the results. */
export function gachaRoutes(app: FastifyInstance, opts: GachaRoutesOptions): void {
  const { db } = opts;
  const { requireUser, optionalUser } = createAuthHooks(opts);
  const rateLimit = { max: opts.rateLimit.max, timeWindow: opts.rateLimit.timeWindowMs };

  app.get('/api/gacha', { preHandler: optionalUser }, async (request) => {
    const pity = request.user ? (await getSave(db, request.user.id)).pity : null;
    return gachaInfo(pity);
  });

  app.post(
    '/api/gacha/pull',
    { preHandler: requireUser, config: { rateLimit } },
    async (request) => {
      const body = parseBody(pullBody, request.body);
      const userId = currentUser(request).id;
      const result = await pullGacha(db, userId, body);
      return { ...result, save: await getSave(db, userId) };
    },
  );
}
