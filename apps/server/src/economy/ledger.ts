import { ApiError } from '../http/errors.js';

export const CURRENCIES = ['coins', 'tickets_x1', 'tickets_x10', 'gems'] as const;
export type Currency = (typeof CURRENCIES)[number];
export type Balances = Record<Currency, number>;

/** Why a balance changed. Add new reasons here so they stay greppable. */
export type LedgerReason =
  | 'starting_grant'
  | 'run_reward'
  | 'upgrade_purchase'
  | 'gacha_pull'
  | 'gacha_refund'
  | 'mission_reward'
  | 'achievement_reward'
  /**
   * A zero-coin marker written when a Pokémon is prestiged (`refId` `dex:prestige:stars`), so
   * the coins spent on its upgrades since its last prestige can be summed from the ledger.
   */
  | 'prestige'
  /** Gems spent on a prestige (`refId` `dex:prestige:stars`). */
  | 'prestige_cost'
  /** Gems spent on resetting a Pokémon's upgrades (`refId` `dex:reset`). */
  | 'upgrade_reset_cost'
  /**
   * Coins given back by an upgrade reset (`refId` `dex:reset`): every `upgrade_purchase` of the
   * Pokémon since its last prestige or reset, whichever came last.
   */
  | 'upgrade_refund'
  | 'admin_adjustment';

export interface LedgerEntry {
  currency: Currency;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  refId: string | null;
}

export class InsufficientFundsError extends ApiError {
  constructor(
    readonly currency: Currency,
    readonly needed: number,
    readonly available: number,
  ) {
    super(409, 'insufficient_funds', `Needs ${needed} ${currency}, has ${available}`);
  }
}

/**
 * Applies balance changes in memory and records a ledger entry for each. Used by
 * `withLockedSave`, which persists the balances and entries in the same transaction.
 */
export class Wallet {
  readonly entries: LedgerEntry[] = [];
  readonly #balances: Balances;

  constructor(balances: Balances) {
    this.#balances = { ...balances };
  }

  get balances(): Readonly<Balances> {
    return this.#balances;
  }

  /**
   * Adds `delta` (negative to spend). Throws `InsufficientFundsError` if the balance would go
   * below zero; nothing is applied in that case.
   */
  change(currency: Currency, delta: number, reason: LedgerReason, refId?: string): void {
    if (!Number.isSafeInteger(delta)) throw new Error(`Invalid ${currency} delta: ${delta}`);
    if (delta === 0) return;
    const balanceAfter = this.#balances[currency] + delta;
    if (balanceAfter < 0)
      throw new InsufficientFundsError(currency, -delta, this.#balances[currency]);
    this.#balances[currency] = balanceAfter;
    this.entries.push({ currency, delta, balanceAfter, reason, refId: refId ?? null });
  }

  /**
   * Records an event that moves no balance (a zero-delta entry), as a marker other ledger
   * queries can order against.
   */
  mark(currency: Currency, reason: LedgerReason, refId?: string): void {
    const balanceAfter = this.#balances[currency];
    this.entries.push({ currency, delta: 0, balanceAfter, reason, refId: refId ?? null });
  }

  credit(currency: Currency, amount: number, reason: LedgerReason, refId?: string): void {
    if (amount < 0) throw new Error('credit() takes a non-negative amount');
    this.change(currency, amount, reason, refId);
  }

  debit(currency: Currency, amount: number, reason: LedgerReason, refId?: string): void {
    if (amount < 0) throw new Error('debit() takes a non-negative amount');
    this.change(currency, -amount, reason, refId);
  }
}
