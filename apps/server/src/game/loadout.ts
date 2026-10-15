import type { PlayerConfig } from '@pokesurvivor/sim';
import type { Executor } from '../db/index.js';
import { getSave, ownsPokemon } from '../saves/service.js';
import type { SaveView } from '../saves/service.js';

export interface Partner {
  dex: number;
  shiny: boolean;
  /** Its prestige stars; absent when it has none. */
  prestige?: number;
}

/** The partner a member will play, from their save; null if none is chosen or it isn't owned. */
export function partnerOf(save: SaveView): Partner | null {
  const { dex } = save.partner;
  if (dex === null || !ownsPokemon(save, dex)) return null;
  const prestige = save.prestige[String(dex)];
  return {
    dex,
    shiny: save.partner.shiny && ownsPokemon(save, dex, true),
    ...(prestige ? { prestige } : {}),
  };
}

export interface Loadout {
  config: PlayerConfig;
  /** Pokémon the player owned at the start (a rescued one they own pays coins instead). */
  owned: ReadonlySet<number>;
}

/**
 * What a player brings into a coop run, read from their server save (never from the client):
 * the partner, its permanent upgrades, prestige stars, move bindings and bans, and the
 * legendaries they have beaten (rifts favour the others).
 */
export async function loadLoadout(db: Executor, userId: string): Promise<Loadout | null> {
  const save = await getSave(db, userId);
  const partner = partnerOf(save);
  if (!partner) return null;
  const key = String(partner.dex);
  return {
    config: {
      id: userId,
      dex: partner.dex,
      shiny: partner.shiny,
      upgrades: save.upgrades[key] ?? {},
      prestige: save.prestige[key] ?? 0,
      bannedMoves: save.moveBans[key] ?? [],
      moveBindings: save.moveBindings[key] ?? [],
      legendsBeaten: Object.keys(save.legendsBeaten).map(Number),
    },
    owned: new Set(Object.keys(save.owned).map(Number)),
  };
}
