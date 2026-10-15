import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { allUpgradesMaxed, clampStars, personalityScores, topTrait } from '@pokesurvivor/data';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import { getServerData, knownDexSchema, pokemonOf } from '../data.js';
import type { Database } from '../db/index.js';
import { pokemonPrestiges } from '../db/schema.js';
import { upgradeCost } from '../economy/config.js';
import type { EconomyConfig } from '../economy/config.js';
import { ApiError, parseBody } from '../http/errors.js';
import { checkAchievements } from '../progress/achievements.js';
import {
  MAX_MOVE_BANS,
  MAX_FAVOURITES,
  MOVE_SLOTS,
  profileSchema,
  settingsSchema,
} from './schema.js';
import { getSave, ownsPokemon, withLockedSave } from './service.js';

export interface SaveRoutesOptions {
  db: Database;
  secureCookies: boolean;
  economy: EconomyConfig;
  /** The partner changed (the room, if any, shows the new one to its members). */
  onPartnerChanged?: (userId: string) => void;
}

const partnerBody = z.object({ dex: knownDexSchema, shiny: z.boolean().default(false) });
const profileBody = z
  .object({
    favourites: z.array(z.object({ dex: knownDexSchema, shiny: z.boolean() })).max(MAX_FAVOURITES),
    title: profileSchema.shape.title,
  })
  .partial();
const settingsBody = settingsSchema.partial();
const upgradeBody = z.object({ dex: knownDexSchema, upgradeId: z.string().min(1).max(32) });
const prestigeBody = z.object({ dex: knownDexSchema });
const starterBody = z.object({
  dex: knownDexSchema,
  /** Index of the answer picked for each personality-test question, if the test was taken. */
  answers: z.array(z.number().int().nonnegative()).max(64).optional(),
});
const movesParams = z.object({ dex: z.coerce.number().pipe(knownDexSchema) });
const moveId = z.string().min(1).max(32);
const movesBody = z
  .object({
    bindings: z.array(moveId.nullable()).length(MOVE_SLOTS),
    bans: z.array(moveId).max(MAX_MOVE_BANS),
  })
  .partial();

/** Upgrade id whose level is how many moves a Pokémon may ban. */
const BAN_UPGRADE = 'ban';

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
    opts.onPartnerChanged?.(userId);
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
        if (body.title !== null) {
          if (!getServerData().achievementById.get(body.title)?.title)
            throw new ApiError(400, 'unknown_title', `Achievement ${body.title} has no title`);
          if (save.data.achievements[body.title] === undefined)
            throw new ApiError(409, 'title_locked', `Achievement ${body.title} is not unlocked`);
        }
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

  /**
   * Grants the first Pokémon: a starter from `starters.json`, normally the personality test's
   * suggestion, but legacy lets you pick any starter. Only while the save owns no Pokémon.
   */
  app.post('/api/save/starter', { preHandler: requireUser }, async (request) => {
    const { dex, answers } = parseBody(starterBody, request.body);
    const data = getServerData();
    if (!data.starterByDex.has(dex))
      throw new ApiError(400, 'not_a_starter', `Pokémon ${dex} is not a starter`);
    let personality: { trait: string; scores: Record<string, number> } | null = null;
    if (answers) {
      const scores = personalityScores(data.starters.personalityTest, answers);
      const trait = scores && topTrait(scores);
      if (!scores || !trait)
        throw new ApiError(400, 'invalid_answers', 'The answers do not fit the personality test');
      personality = { trait, scores };
    }
    const userId = currentUser(request).id;
    const achievements = await withLockedSave(db, userId, (save) => {
      if (Object.keys(save.data.owned).length > 0)
        throw new ApiError(409, 'starter_already_chosen', 'The save already has Pokémon');
      const now = Date.now();
      save.data.owned[String(dex)] = { at: now, from: 'starter' };
      save.data.starter = dex;
      save.data.personality = personality;
      save.partner = { dex, shiny: false };
      return checkAchievements(save, now);
    });
    return { achievements, save: await getSave(db, userId) };
  });

  /**
   * A Pokémon's move slot bindings (which move always goes in slot 1–4) and banned moves (never
   * offered in level-up cards; as many as its `ban` upgrade level). Legacy `pbind` / `pban`.
   */
  app.put('/api/save/moves/:dex', { preHandler: requireUser }, async (request) => {
    const { dex } = parseBody(movesParams, request.params);
    const body = parseBody(movesBody, request.body);
    const data = getServerData();
    const pokemon = pokemonOf(dex);
    const startingMove = data.startingMoveOf(pokemon);
    const pool = new Set(data.movePoolOf(pokemon).map((m) => m.id));
    const userId = currentUser(request).id;
    await withLockedSave(db, userId, (save) => {
      if (!ownsPokemon(save.data, dex)) throw notOwned(dex, false);
      const key = String(dex);
      if (body.bindings) {
        const ids = body.bindings.filter((id) => id !== null);
        for (const id of ids)
          if (id !== startingMove && !pool.has(id))
            throw new ApiError(400, 'invalid_move', `${pokemon.id} can't learn ${id}`);
        if (new Set(ids).size !== ids.length) throw new ApiError(400, 'duplicate_move');
        if (ids.length > 0) save.data.moveBindings[key] = body.bindings;
        else delete save.data.moveBindings[key];
      }
      if (body.bans) {
        for (const id of body.bans)
          if (id === startingMove || !pool.has(id))
            throw new ApiError(400, 'invalid_move', `${pokemon.id} can't ban ${id}`);
        if (new Set(body.bans).size !== body.bans.length) throw new ApiError(400, 'duplicate_move');
        const allowed = save.data.upgrades[key]?.[BAN_UPGRADE] ?? 0;
        if (body.bans.length > allowed)
          throw new ApiError(409, 'too_many_bans', `Can ban ${allowed} moves`);
        if (body.bans.length > 0) save.data.moveBans[key] = body.bans;
        else delete save.data.moveBans[key];
      }
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

  /**
   * Prestige: once every upgrade of an owned Pokémon is maxed, reset its upgrades (Repertoire and
   * Ban too) and banned moves for a star, up to `tuning.prestige.maxStars`. Free. Move slot
   * bindings stay: they don't depend on any upgrade.
   */
  app.post('/api/save/prestige', { preHandler: requireUser }, async (request) => {
    const { dex } = parseBody(prestigeBody, request.body);
    const tuning = getServerData().tuning.prestige;
    const maxLevels = Object.fromEntries(
      Object.entries(economy.upgrades).map(([id, def]) => [id, def.maxLevel]),
    );
    const userId = currentUser(request).id;
    await withLockedSave(db, userId, async (save, tx) => {
      if (!ownsPokemon(save.data, dex)) throw notOwned(dex, false);
      const key = String(dex);
      const stars = clampStars(tuning, save.data.prestige[key]);
      if (stars >= tuning.maxStars)
        throw new ApiError(409, 'prestige_maxed', `Pokémon ${dex} has ${stars} stars`);
      const levels = save.data.upgrades[key] ?? {};
      if (!allUpgradesMaxed(maxLevels, levels))
        throw new ApiError(409, 'prestige_not_ready', `Pokémon ${dex} has upgrades left to buy`);
      const moveBans = save.data.moveBans[key] ?? [];
      delete save.data.upgrades[key];
      delete save.data.moveBans[key];
      save.data.prestige[key] = stars + 1;
      save.wallet.mark('coins', 'prestige', `${dex}:prestige:${stars + 1}`);
      await tx
        .insert(pokemonPrestiges)
        .values({ userId, dex, stars: stars + 1, reset: { upgrades: levels, moveBans } });
    });
    // A room's lobby shows the partner's stars.
    opts.onPartnerChanged?.(userId);
    return getSave(db, userId);
  });
}
