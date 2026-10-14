import { describe, expect, it } from 'vitest';
import { shopPick } from './shop-pick.js';

describe('shopPick', () => {
  const owned = [1, 4, 7];

  it('opens on the partner the first time', () => {
    expect(shopPick({ dex: null, partner: null }, 4, owned)).toEqual({ dex: 4, partner: 4 });
  });

  it('remembers another Pokémon picked in the shop while the partner stays', () => {
    expect(shopPick({ dex: 7, partner: 4 }, 4, owned)).toEqual({ dex: 7, partner: 4 });
  });

  it('follows the partner after it changes', () => {
    expect(shopPick({ dex: 7, partner: 4 }, 1, owned)).toEqual({ dex: 1, partner: 1 });
    expect(shopPick({ dex: 4, partner: 4 }, 7, owned)).toEqual({ dex: 7, partner: 7 });
  });

  it('falls back to the partner when the pick is no longer owned', () => {
    expect(shopPick({ dex: 9, partner: 4 }, 4, owned)).toEqual({ dex: 4, partner: 4 });
  });

  it('falls back to the first owned without a partner', () => {
    expect(shopPick({ dex: null, partner: null }, null, owned)).toEqual({ dex: 1, partner: null });
    expect(shopPick({ dex: null, partner: null }, null, [])).toEqual({ dex: null, partner: null });
  });
});
