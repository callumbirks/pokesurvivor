import { emptyRunProgress } from '@pokesurvivor/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import { getServerData, knownDexSchema, pokemonTypeSchema } from '../data.js';
import type { Database } from '../db/index.js';
import type { RunCaps } from '../economy/config.js';
import { ApiError, parseBody } from '../http/errors.js';
import { runConfigOf, type LiveConfig } from '../live-config/store.js';
import { getSave } from '../saves/service.js';
import { getLeaderboard } from './leaderboard.js';
import { checkpointSoloRun, finishSoloRun, startSoloRun } from './service.js';

export interface RunRoutesOptions {
  db: Database;
  secureCookies: boolean;
  runCaps: RunCaps;
  leaderboardTimeZone: string;
  rateLimit: { max: number; timeWindowMs: number };
  /**
   * Whether the user is a member of a room (the game server's `roomOfUser`): a player in a party
   * can't start a solo run. Absent without a game server.
   */
  inRoom?: (userId: string) => boolean | Promise<boolean>;
  /**
   * A solo run was reported, or found closed (the game server drops it from the player's
   * presence). Absent without a game server.
   */
  runClosed?: (userId: string, runId: string) => void;
  /** Live tuning: the config each new solo run is issued (the defaults, version 0, without). */
  liveConfig?: LiveConfig;
}

const count = z.number().int().nonnegative().max(1_000_000);

const itemId = z
  .string()
  .max(32)
  .refine((id) => getServerData().itemById.has(id), { message: 'Unknown item' });
const moveId = z
  .string()
  .max(32)
  .refine((id) => getServerData().moveById.has(id), { message: 'Unknown move' });

/** `RunProgress` (`packages/protocol`); missing for clients that don't track it yet. */
const progressBody = z
  .object({
    defeatsByType: z.partialRecord(pokemonTypeSchema, count),
    chestsOpened: count,
    itemsEquipped: z.array(itemId).max(100),
    movesEvolved: z.array(moveId).max(100),
    riftWins: z.array(pokemonTypeSchema).max(100),
    legendariesDefeated: z.array(knownDexSchema).max(100),
    rescued: z.array(knownDexSchema).max(100),
  })
  .default(() => ({ ...emptyRunProgress(), riftWins: [] }));

const startBody = z.object({ pokemon: z.object({ dex: knownDexSchema, shiny: z.boolean() }) });
const finishBody = z.object({
  runId: z.uuid(),
  durationS: count,
  level: count,
  kills: count,
  bosses: count,
  coins: count,
  ticketsX1: count,
  ticketsX10: count,
  shiniesCaught: z.array(knownDexSchema).max(100),
  progress: progressBody,
});
const leaderboardQuery = z.object({
  mode: z.enum(['solo', 'group']).default('solo'),
  period: z.enum(['daily', 'weekly', 'all']).default('all'),
  friends: z.enum(['true', 'false']).default('false'),
  pokemon: z.coerce.number().pipe(knownDexSchema).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function runRoutes(app: FastifyInstance, opts: RunRoutesOptions): void {
  const { db, runCaps } = opts;
  const { requireUser, optionalUser } = createAuthHooks(opts);
  const rateLimit = { max: opts.rateLimit.max, timeWindow: opts.rateLimit.timeWindowMs };

  app.post(
    '/api/runs/start',
    { preHandler: requireUser, config: { rateLimit } },
    async (request, reply) => {
      const { pokemon } = parseBody(startBody, request.body);
      const userId = currentUser(request).id;
      if (await opts.inRoom?.(userId))
        throw new ApiError(409, 'in_room', 'Leave your room to start a solo run');
      // The server issues the config (and records its version): the client never says which.
      const config = await opts.liveConfig?.current();
      const run = await startSoloRun(db, userId, pokemon, config?.version ?? 0);
      return reply.status(201).send({
        runId: run.runId,
        startedAt: run.startedAt.toISOString(),
        ...(config ? { config: runConfigOf(config) } : {}),
      });
    },
  );

  app.post(
    '/api/runs/checkpoint',
    { preHandler: requireUser, config: { rateLimit } },
    async (request) => {
      const { runId, ...claim } = parseBody(finishBody, request.body);
      return checkpointSoloRun(db, currentUser(request).id, runId, claim, runCaps);
    },
  );

  app.post('/api/runs', { preHandler: requireUser }, async (request) => {
    const { runId, ...claim } = parseBody(finishBody, request.body);
    const userId = currentUser(request).id;
    const result = await finishSoloRun(db, userId, runId, claim, runCaps, {
      timeZone: opts.leaderboardTimeZone,
    }).catch((err: unknown) => {
      if (err instanceof ApiError && (err.statusCode === 404 || err.statusCode === 409))
        opts.runClosed?.(userId, runId);
      throw err;
    });
    opts.runClosed?.(userId, runId);
    return { ...result, save: await getSave(db, userId) };
  });

  app.get('/api/leaderboard', { preHandler: optionalUser }, async (request) => {
    const q = parseBody(leaderboardQuery, request.query);
    const friendsOnly = q.friends === 'true';
    if (friendsOnly && !request.user)
      throw new ApiError(401, 'unauthenticated', 'The friends filter needs a login');
    const board = await getLeaderboard(db, {
      mode: q.mode,
      period: q.period,
      friendsOnly,
      pokemonDex: q.pokemon,
      limit: q.limit,
      viewerId: request.user?.id ?? null,
      timeZone: opts.leaderboardTimeZone,
    });
    return { mode: q.mode, period: q.period, ...board };
  });
}
