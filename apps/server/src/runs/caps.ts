import type { RunProgress, RunSummary } from '@pokesurvivor/protocol';
import { getServerData } from '../data.js';
import type { RunCaps } from '../economy/config.js';

/** The per-player numbers of a run, as reported by the client or produced by the server sim. */
export type RunStats = RunSummary;

export interface CappedRun {
  stats: RunStats;
  /** True if anything was reduced. */
  capped: boolean;
}

/** Lost Pokémon legacy can spawn: up to 3★, not legendary, with sprites, not hovering. */
export function isRescuable(dex: number): boolean {
  const data = getServerData();
  const pokemon = data.pokemonByDex.get(dex);
  const sprites = data.spritesByDex.get(dex);
  return !!pokemon && !!sprites && pokemon.rarity <= 3 && !pokemon.legendary && !sprites.hovers;
}

/** Rift legendaries: legendary Pokémon with sprites (legacy `rift.js`). */
export function isRiftLegendary(dex: number): boolean {
  const data = getServerData();
  return !!data.pokemonByDex.get(dex)?.legendary && data.hasSprite(dex);
}

const unique = <T>(list: readonly T[]) => [...new Set(list)];

/**
 * Clamps a client-reported solo run to what is plausible: the duration to the wall-clock time
 * since the run was started, and everything else to per-minute rates of that duration. Ids are
 * already validated against the data by the route; entries that can't happen (a shiny without
 * shiny sprites, a non-legendary "legendary") are dropped.
 */
export function capRunStats(claim: RunStats, caps: RunCaps, elapsedS: number): CappedRun {
  const data = getServerData();
  const durationS = Math.max(0, Math.min(claim.durationS, Math.floor(elapsedS), caps.maxDurationS));
  const minutes = durationS / 60;
  const limit = (flat: number, perMinute: number) =>
    Math.max(0, Math.floor(flat + perMinute * minutes));

  const kills = Math.min(claim.kills, limit(0, caps.killsPerMinute));
  const shinyLimit = Math.min(caps.shiniesMax, limit(caps.shiniesFlat, caps.shiniesPerMinute));
  const p = claim.progress;
  const riftWins = p.riftWins.slice(0, limit(caps.riftWinsFlat, caps.riftWinsPerMinute));
  const progress: RunProgress = {
    defeatsByType: Object.fromEntries(
      Object.entries(p.defeatsByType).map(([type, n]) => [type, Math.min(n ?? 0, kills)]),
    ),
    chestsOpened: Math.min(p.chestsOpened, limit(caps.chestsFlat, caps.chestsPerMinute)),
    itemsEquipped: p.itemsEquipped.slice(0, limit(caps.itemsFlat, caps.itemsPerMinute)),
    movesEvolved: p.movesEvolved.slice(0, limit(caps.evolutionsFlat, caps.evolutionsPerMinute)),
    riftWins,
    legendariesDefeated: unique(p.legendariesDefeated)
      .filter(isRiftLegendary)
      .slice(0, riftWins.length),
    rescued: unique(p.rescued)
      .filter(isRescuable)
      .slice(0, Math.min(caps.rescuesMax, limit(caps.rescuesFlat, caps.rescuesPerMinute))),
  };
  const stats: RunStats = {
    durationS,
    level: Math.min(claim.level, caps.maxLevel),
    kills,
    bosses: Math.min(claim.bosses, limit(0, caps.bossesPerMinute)),
    coins: Math.min(claim.coins, limit(caps.coinsFlat, caps.coinsPerMinute)),
    ticketsX1: Math.min(claim.ticketsX1, limit(caps.ticketsX1Flat, caps.ticketsX1PerMinute)),
    ticketsX10: Math.min(claim.ticketsX10, limit(caps.ticketsX10Flat, caps.ticketsX10PerMinute)),
    shiniesCaught: unique(claim.shiniesCaught)
      .filter((dex) => data.hasShinySprite(dex))
      .slice(0, shinyLimit),
    progress,
  };
  return { stats, capped: fingerprint(stats) !== fingerprint(claim) };
}

/** Every number of a run in a fixed order, to tell whether capping changed anything. */
function fingerprint(s: RunStats): string {
  const p = s.progress;
  return JSON.stringify([
    s.durationS,
    s.level,
    s.kills,
    s.bosses,
    s.coins,
    s.ticketsX1,
    s.ticketsX10,
    s.shiniesCaught,
    p.defeatsByType,
    p.chestsOpened,
    p.itemsEquipped,
    p.movesEvolved,
    p.riftWins,
    p.legendariesDefeated,
    p.rescued,
  ]);
}
