import type { PlayerConfig } from '@pokesurvivor/sim';
import type { Executor } from '../db/index.js';
import { getSave, ownsPokemon } from '../saves/service.js';
import type { SaveView } from '../saves/service.js';

export interface Partner {
  dex: number;
  shiny: boolean;
}

/** The partner a member will play, from their save; null if none is chosen or it isn't owned. */
export function partnerOf(save: SaveView): Partner | null {
  const { dex } = save.partner;
  if (dex === null || !ownsPokemon(save, dex)) return null;
  return { dex, shiny: save.partner.shiny && ownsPokemon(save, dex, true) };
}

/**
 * What a player brings into a coop run, read from their server save (never from the client):
 * the partner, its permanent upgrades, move bindings and bans.
 */
export async function loadLoadout(db: Executor, userId: string): Promise<PlayerConfig | null> {
  const save = await getSave(db, userId);
  const partner = partnerOf(save);
  if (!partner) return null;
  const key = String(partner.dex);
  return {
    id: userId,
    dex: partner.dex,
    shiny: partner.shiny,
    upgrades: save.upgrades[key] ?? {},
    bannedMoves: save.moveBans[key] ?? [],
    moveBindings: save.moveBindings[key] ?? [],
  };
}
