import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import type { Database } from '../db/index.js';
import { parseBody } from '../http/errors.js';
import { getSave, withLockedSave } from '../saves/service.js';
import type { LockedSave } from '../saves/service.js';
import { claimMission, ensureMissions, periodsAt, rerollDailyMission } from './missions.js';

export interface MissionRoutesOptions {
  db: Database;
  secureCookies: boolean;
  /** Daily and weekly missions roll over at midnight in this time zone. */
  timeZone: string;
}

const claimParams = z.object({
  kind: z.enum(['daily', 'weekly']),
  index: z.coerce.number().int().min(0).max(15),
});
const rerollParams = z.object({ index: z.coerce.number().int().min(0).max(15) });

/**
 * Daily and weekly missions. Each read rolls the current period's missions if needed, so they
 * are stored with the save; achievements unlock on their own wherever progress changes.
 */
export function missionRoutes(app: FastifyInstance, opts: MissionRoutesOptions): void {
  const { db, timeZone } = opts;
  const { requireUser } = createAuthHooks(opts);
  const current = (save: LockedSave) => {
    ensureMissions(save, periodsAt(new Date(), timeZone));
    return save.data.missions;
  };

  app.get('/api/missions', { preHandler: requireUser }, (request) =>
    withLockedSave(db, currentUser(request).id, current),
  );

  app.post('/api/missions/:kind/:index/claim', { preHandler: requireUser }, async (request) => {
    const { kind, index } = parseBody(claimParams, request.params);
    const userId = currentUser(request).id;
    const result = await withLockedSave(db, userId, (save) => {
      current(save);
      const achievements = claimMission(save, kind, index);
      return { missions: save.data.missions, achievements };
    });
    return { ...result, save: await getSave(db, userId) };
  });

  app.post('/api/missions/daily/:index/reroll', { preHandler: requireUser }, (request) => {
    const { index } = parseBody(rerollParams, request.params);
    return withLockedSave(db, currentUser(request).id, (save) => {
      current(save);
      rerollDailyMission(save, index);
      return save.data.missions;
    });
  });
}
