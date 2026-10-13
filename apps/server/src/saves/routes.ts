import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import type { Database } from '../db/index.js';
import { upgradeCost } from '../economy/config.js';
import type { EconomyConfig } from '../economy/config.js';
import { ApiError, parseBody } from '../http/errors.js';
import {
  dexSchema,
  favouriteSchema,
  MAX_FAVOURITES,
  profileSchema,
  settingsSchema,
} from './schema.js';
import { getSave, ownsPokemon, withLockedSave } from './service.js';

export interface SaveRoutesOptions {
  db: Database;
  secureCookies: boolean;
  economy: EconomyConfig;
}

const partnerBody = z.object({ dex: dexSchema, shiny: z.boolean().default(false) });
const profileBody = z
  .object({
    favourites: z.array(favouriteSchema).max(MAX_FAVOURITES),
    title: profileSchema.shape.title,
  })
  .partial();
const settingsBody = settingsSchema.partial();
const upgradeBody = z.object({ dex: dexSchema, upgradeId: z.string().min(1).max(32) });

function notOwned(dex: number, shiny: boolean): ApiError {
  return new ApiError(
    409,
    'pokemon_not_owned',
    `Pokémon ${dex}${shiny ? ' (shiny)' : ''} is not owned`,
  );
}

/**
 * The save endpoints. The client can only change its partner, profile and settings, and buy
 * upgrades; balances and the collection change only through server logic.
 */
export function saveRoutes(app: FastifyInstance, opts: SaveRoutesOptions): void {
  const { db, economy } = opts;
  const { requireUser } = createAuthHooks(opts);

  app.get('/api/save', { preHandler: requireUser }, (request) =>
    getSave(db, currentUser(request).id),
  );

  /** The upgrade table, so the shop can show the same costs the server charges. */
  app.get('/api/upgrades', () => ({ upgrades: economy.upgrades }));

  app.put('/api/save/partner', { preHandler: requireUser }, async (request) => {
    const { dex, shiny } = parseBody(partnerBody, request.body);
    const userId = currentUser(request).id;
    await withLockedSave(db, userId, (save) => {
      if (!ownsPokemon(save.data, dex, shiny)) throw notOwned(dex, shiny);
      save.partner = { dex, shiny };
    });
    return getSave(db, userId);
  });

  app.patch('/api/save/profile', { preHandler: requireUser }, async (request) => {
    const body = parseBody(profileBody, request.body);
    const userId = currentUser(request).id;
    await withLockedSave(db, userId, (save) => {
      if (body.favourites) {
        const seen = new Set<string>();
        for (const { dex, shiny } of body.favourites) {
          if (!ownsPokemon(save.data, dex, shiny)) throw notOwned(dex, shiny);
          const key = `${dex}:${shiny}`;
          if (seen.has(key)) throw new ApiError(400, 'duplicate_favourite');
          seen.add(key);
        }
        save.data.profile.favourites = body.favourites;
      }
      if (body.title !== undefined) {
        if (body.title !== null && save.data.achievements[body.title] === undefined)
          throw new ApiError(409, 'title_locked', `Achievement ${body.title} is not unlocked`);
        save.data.profile.title = body.title;
      }
    });
    return getSave(db, userId);
  });

  app.patch('/api/save/settings', { preHandler: requireUser }, async (request) => {
    const body = parseBody(settingsBody, request.body);
    const userId = currentUser(request).id;
    await withLockedSave(db, userId, (save) => {
      save.data.settings = { ...save.data.settings, ...body };
    });
    return getSave(db, userId);
  });

  app.post('/api/save/upgrades', { preHandler: requireUser }, async (request) => {
    const { dex, upgradeId } = parseBody(upgradeBody, request.body);
    const def = Object.hasOwn(economy.upgrades, upgradeId)
      ? economy.upgrades[upgradeId]
      : undefined;
    if (!def) throw new ApiError(400, 'unknown_upgrade', `Unknown upgrade ${upgradeId}`);
    const userId = currentUser(request).id;
    await withLockedSave(db, userId, (save) => {
      if (!ownsPokemon(save.data, dex)) throw notOwned(dex, false);
      const levels = (save.data.upgrades[String(dex)] ??= {});
      const level = levels[upgradeId] ?? 0;
      if (level >= def.maxLevel) throw new ApiError(409, 'upgrade_maxed');
      save.wallet.debit(
        'coins',
        upgradeCost(def, level),
        'upgrade_purchase',
        `${dex}:${upgradeId}:${level + 1}`,
      );
      levels[upgradeId] = level + 1;
    });
    return getSave(db, userId);
  });
}
