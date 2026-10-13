import { eq, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../db/index.js';
import { currencyLedger, saves } from '../db/schema.js';
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
  partner: Partner;
  updatedAt: string;
}

type SaveRow = typeof saves.$inferSelect;

function balancesOf(row: SaveRow): Balances {
  return { coins: row.coins, tickets_x1: row.ticketsX1, tickets_x10: row.ticketsX10 };
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
    partner: { dex: row.partnerDex, shiny: row.partnerShiny },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function ownsPokemon(data: SaveData, dex: number, shiny = false): boolean {
  return (shiny ? data.shiny : data.owned)[String(dex)] !== undefined;
}
