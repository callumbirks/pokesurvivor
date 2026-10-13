import type { Intent, PendingChoice } from '@pokesurvivor/sim';

/**
 * The intent that takes a choice's first option (bots, debug views, "pick for me"). Null for a
 * choice kind this doesn't know: it still resolves by itself at its deadline.
 */
export function firstOption(c: PendingChoice): Intent | null {
  switch (c.kind) {
    case 'level-up':
      return { type: 'pickCard', choiceId: c.id, cardId: c.options[0]?.id ?? '' };
    case 'item':
      return { type: 'pickItem', choiceId: c.id, itemId: c.held };
    case 'bond':
      return {
        type: 'pickBond',
        choiceId: c.id,
        moves: c.loose.slice(0, c.mode === 'pair' ? 2 : 1),
      };
    default:
      return null;
  }
}
