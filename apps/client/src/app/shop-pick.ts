// Which Pokémon the shop (Upgrades) opens on. It follows the partner: after the partner changes
// (in the collection, on the menu, …) it opens on the new one; otherwise it remembers the last
// Pokémon picked in the shop, as long as it is still owned.

/** The shop's remembered pick, and the partner it was made under. */
export interface ShopPick {
  dex: number | null;
  partner: number | null;
}

export function shopPick(
  prev: ShopPick,
  partner: number | null,
  owned: readonly number[],
): ShopPick {
  const fallback = partner ?? owned[0] ?? null;
  if (prev.partner !== partner) return { dex: fallback, partner };
  if (prev.dex === null || !owned.includes(prev.dex)) return { dex: fallback, partner };
  return prev;
}
