import type { Reward } from '@pokesurvivor/data';
import type { LedgerReason } from '../economy/ledger.js';
import type { LockedSave } from '../saves/service.js';

/** Credits a data-file reward (`{ coins?, tickets?, tickets10? }`) through the ledger. */
export function creditReward(
  save: LockedSave,
  reward: Reward,
  reason: LedgerReason,
  refId: string,
): void {
  if (reward.coins) save.wallet.credit('coins', reward.coins, reason, refId);
  if (reward.tickets) save.wallet.credit('tickets_x1', reward.tickets, reason, refId);
  if (reward.tickets10) save.wallet.credit('tickets_x10', reward.tickets10, reason, refId);
}
