import { and, eq, gt, inArray, like, max, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/index.js';
import { currencyLedger, saves } from '../db/schema.js';
import { upgradeCost, type UpgradeDef } from '../economy/config.js';
import { Wallet } from '../economy/ledger.js';
import type { Balances } from '../economy/ledger.js';
import { ApiError } from '../http/errors.js';
import { SAVE_DATA_VERSION, migrateSaveData, newSaveData, saveDataSchema } from './schema.js';
import type { SaveData } from './schema.js';

export interface Partner {
  dex: number | null;
  shiny: boolean;
}

/**
 * A save locked for update (`SELECT … FOR UPDATE`) inside a transaction. Mutate `data` and
 * `partner` freely and change balances through `wallet`; `withLockedSave` writes it all back.
 */
export interface LockedSave {
  readonly userId: string;
  data: SaveData;
  partner: Partner;
  readonly wallet: Wallet;
}

/** What `GET /api/save` returns. */
export interface SaveView extends SaveData {
  version: number;
  coins: number;
  tickets: { x1: number; x10: number };
  gems: number;
  partner: Partner;
  updatedAt: string;
}

type SaveRow = typeof saves.$inferSelect;

function balancesOf(row: SaveRow): Balances {
  return {
    coins: row.coins,
    tickets_x1: row.ticketsX1,
    tickets_x10: row.ticketsX10,
    gems: row.gems,
  };
}

/**
 * Runs `fn` with the user's save locked, then persists the save, balances and ledger entries
 * atomically. If `fn` throws, nothing is written. Runs as a savepoint when `db` is already a
 * transaction, so several saves can be updated in one transaction (lock them in a stable order,
 * e.g. sorted by user id, to avoid deadlocks).
 *
 * This is the one way to change a save; the gacha should use it too.
 */
export async function withLockedSave<T>(
  db: Executor,
  userId: string,
  fn: (save: LockedSave, tx: Transaction) => Promise<T> | T,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(saves).where(eq(saves.userId, userId)).for('update');
    if (!row) throw new ApiError(404, 'save_not_found', `No save for user ${userId}`);

    const save: LockedSave = {
      userId,
      data: migrateSaveData(row.dataVersion, row.data),
      partner: { dex: row.partnerDex, shiny: row.partnerShiny },
      wallet: new Wallet(balancesOf(row)),
    };
    const result = await fn(save, tx);

    const { balances, entries } = save.wallet;
    await tx
      .update(saves)
      .set({
        data: saveDataSchema.parse(save.data),
        dataVersion: SAVE_DATA_VERSION,
        partnerDex: save.partner.dex,
        partnerShiny: save.partner.shiny,
        coins: balances.coins,
        ticketsX1: balances.tickets_x1,
        ticketsX10: balances.tickets_x10,
        gems: balances.gems,
        updatedAt: sql`now()`,
      })
      .where(eq(saves.userId, userId));
    if (entries.length > 0)
      await tx.insert(currencyLedger).values(entries.map((entry) => ({ userId, ...entry })));
    return result;
  });
}

/** Creates the save for a new user and credits the starting coins through the ledger. */
export async function createSave(
  db: Executor,
  userId: string,
  startingCoins: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(saves).values({ userId, dataVersion: SAVE_DATA_VERSION, data: newSaveData() });
    await withLockedSave(tx, userId, (save) => {
      save.wallet.credit('coins', startingCoins, 'starting_grant');
    });
  });
}

export async function getSave(db: Executor, userId: string): Promise<SaveView> {
  const [row] = await db.select().from(saves).where(eq(saves.userId, userId));
  if (!row) throw new ApiError(404, 'save_not_found', `No save for user ${userId}`);
  return toSaveView(row);
}

export function toSaveView(row: SaveRow): SaveView {
  return {
    ...migrateSaveData(row.dataVersion, row.data),
    version: SAVE_DATA_VERSION,
    coins: row.coins,
    tickets: { x1: row.ticketsX1, x10: row.ticketsX10 },
    gems: row.gems,
    partner: { dex: row.partnerDex, shiny: row.partnerShiny },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function ownsPokemon(data: SaveData, dex: number, shiny = false): boolean {
  return (shiny ? data.shiny : data.owned)[String(dex)] !== undefined;
}

/** What an upgrade reset of a Pokémon gives back (`refundFor`). */
export interface UpgradeRefund {
  /** Coins in all: `recorded + unrecorded`. */
  refund: number;
  /** From the ledger: its `upgrade_purchase` entries since its last prestige or reset. */
  recorded: number;
  /**
   * Its levels with no purchase entry since then (bought before the ledger, e.g. saves imported
   * from legacy), priced at today's costs.
   */
  unrecorded: number;
}

/**
 * Coins spent on `dex`'s upgrades since its last prestige or upgrade reset, whichever came last
 * (or ever): what an upgrade reset gives back. Each level the ledger has a purchase for (an
 * `upgrade_purchase` entry `dex:upgrade:level` after the latest `prestige` marker or
 * `upgrade_refund` of the Pokémon) refunds exactly what it cost; a level of `levels` without
 * one is priced at today's cost (`upgrades`), so upgrades from before the ledger refund too.
 */
export async function refundFor(
  db: Executor,
  userId: string,
  dex: number,
  levels: Record<string, number>,
  upgrades: Record<string, UpgradeDef>,
): Promise<UpgradeRefund> {
  const ofDex = and(
    eq(currencyLedger.userId, userId),
    eq(currencyLedger.currency, 'coins'),
    like(currencyLedger.refId, `${dex}:%`),
  );
  const since = db
    .select({ id: sql`coalesce(${max(currencyLedger.id)}, 0)` })
    .from(currencyLedger)
    .where(and(ofDex, inArray(currencyLedger.reason, ['prestige', 'upgrade_refund'])));
  const bought = await db
    .select({ refId: currencyLedger.refId, delta: currencyLedger.delta })
    .from(currencyLedger)
    .where(and(ofDex, eq(currencyLedger.reason, 'upgrade_purchase'), gt(currencyLedger.id, since)));
  const recorded = bought.reduce((sum, b) => sum - b.delta, 0);
  const paid = new Set(bought.map((b) => b.refId));
  let unrecorded = 0;
  for (const [id, level] of Object.entries(levels)) {
    const def = Object.hasOwn(upgrades, id) ? upgrades[id] : undefined;
    if (!def) continue;
    for (let n = 1; n <= level; n++)
      if (!paid.has(`${dex}:${id}:${n}`)) unrecorded += upgradeCost(def, n - 1);
  }
  return { refund: recorded + unrecorded, recorded, unrecorded };
}
