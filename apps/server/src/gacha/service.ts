import { randomUUID } from 'node:crypto';
import { getServerData } from '../data.js';
import type { Executor } from '../db/index.js';
import { gachaPulls } from '../db/schema.js';
import type { Currency } from '../economy/ledger.js';
import { ApiError } from '../http/errors.js';
import { checkAchievements } from '../progress/achievements.js';
import type { UnlockedAchievement } from '../progress/achievements.js';
import { cryptoRng } from '../random.js';
import type { Rng } from '../random.js';
import type { SaveData } from '../saves/schema.js';
import { withLockedSave } from '../saves/service.js';
import { buildBannerPool, featuredOf, rollPulls } from './engine.js';
import type { BannerPool, PullResult } from './engine.js';

export type PayWith = 'tickets' | 'tickets10';

let pools: Map<string, BannerPool> | undefined;

/** Every banner's pool, built once from the pokedex and the sprite manifest. */
export function bannerPools(): ReadonlyMap<string, BannerPool> {
  if (pools) return pools;
  const data = getServerData();
  pools = new Map(
    data.gacha.banners.map((b) => [b.id, buildBannerPool(b, data.pokedex, data.hasSprite)]),
  );
  return pools;
}

/** What `GET /api/gacha` returns: the rules from `gacha.json` and each banner's pool. */
export function gachaInfo(pity: SaveData['pity'] | null) {
  const { gacha } = getServerData();
  const allPools = bannerPools();
  return {
    cost: gacha.cost,
    rates: gacha.rates,
    softPity: gacha.softPity,
    hardPity: gacha.hardPity,
    multiGuaranteeMinRarity: gacha.multiGuaranteeMinRarity,
    shinyRate: gacha.shinyRate,
    duplicateRefund: gacha.duplicateRefund,
    shinyDuplicateMultiplier: gacha.shinyDuplicateMultiplier,
    rarities: gacha.rarities,
    banners: gacha.banners.map((banner) => {
      const pool = allPools.get(banner.id);
      return {
        ...banner,
        featured: pool ? featuredOf(pool) : [],
        /** Pokémon per rarity in this banner. */
        poolSize: Object.fromEntries(
          [1, 2, 3, 4, 5].map((r) => [String(r), pool?.byRarity.get(r)?.length ?? 0]),
        ),
        pity: pity ? (pity[banner.id] ?? 0) : null,
      };
    }),
  };
}

/** Which currency and how much a pull costs, or a 400 if the combination isn't allowed. */
function costOf(count: number, payWith: PayWith): { currency: Currency; amount: number } {
  const { cost } = getServerData().gacha;
  if (count === 1) {
    if (payWith !== 'tickets')
      throw new ApiError(400, 'invalid_payment', 'A ×10 ticket only pays for a ×10 pull');
    return { currency: 'tickets_x1', amount: cost.single };
  }
  if (count === cost.multiCount) {
    return payWith === 'tickets10'
      ? { currency: 'tickets_x10', amount: cost.multiTickets10 }
      : { currency: 'tickets_x1', amount: cost.multi };
  }
  throw new ApiError(400, 'invalid_pull_count', `Pull 1 or ${cost.multiCount}`);
}

export interface PullRequest {
  banner: string;
  count: number;
  payWith: PayWith;
}

export interface PullResponse {
  pullId: string;
  banner: string;
  results: PullResult[];
  /** The banner's pity after the pulls. */
  pity: number;
  achievements: UnlockedAchievement[];
}

/**
 * Pays for and rolls gacha pulls on a banner under the save lock: spends tickets and credits
 * duplicate refunds through the ledger, adds the Pokémon to the collection, updates the
 * banner's pity and the pull count, unlocks achievements and records the pull.
 */
export async function pullGacha(
  db: Executor,
  userId: string,
  req: PullRequest,
  rng: Rng = cryptoRng,
): Promise<PullResponse> {
  const pool = bannerPools().get(req.banner);
  if (!pool) throw new ApiError(400, 'unknown_banner', `Unknown banner ${req.banner}`);
  const { currency, amount } = costOf(req.count, req.payWith);
  const data = getServerData();
  const pullId = randomUUID();

  return withLockedSave(db, userId, async (save, tx) => {
    save.wallet.debit(currency, amount, 'gacha_pull', pullId);

    const pityBefore = save.data.pity[req.banner] ?? 0;
    const owned = new Set(Object.keys(save.data.owned).map(Number));
    const shiny = new Set(Object.keys(save.data.shiny).map(Number));
    const { results, pity } = rollPulls({
      config: data.gacha,
      pool,
      count: req.count,
      pity: pityBefore,
      owned,
      shiny,
      hasShiny: data.hasShinySprite,
      rng,
    });

    const now = Date.now();
    for (const r of results) {
      save.data.owned[String(r.dex)] ??= { at: now, from: 'gacha' };
      if (r.shiny) save.data.shiny[String(r.dex)] ??= { at: now, from: 'gacha' };
    }
    const refund = results.reduce((sum, r) => sum + r.refund, 0);
    save.wallet.credit('coins', refund, 'gacha_refund', pullId);
    save.data.pity[req.banner] = pity;
    save.data.stats.pulls += req.count;
    const achievements = checkAchievements(save, now);

    await tx.insert(gachaPulls).values({
      id: pullId,
      userId,
      banner: req.banner,
      count: req.count,
      payWith: req.payWith,
      cost: amount,
      pityBefore,
      pityAfter: pity,
      results,
    });
    return { pullId, banner: req.banner, results, pity, achievements };
  });
}
