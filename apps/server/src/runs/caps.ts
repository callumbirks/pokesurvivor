import type { RunCaps } from '../economy/config.js';

/** The per-player numbers of a run, as reported by the client or produced by the server sim. */
export interface RunStats {
  durationS: number;
  level: number;
  kills: number;
  bosses: number;
  coins: number;
  ticketsX1: number;
  ticketsX10: number;
  /** Dex numbers of wild shinies caught. */
  shiniesCaught: number[];
}

export interface CappedRun {
  stats: RunStats;
  /** True if anything was reduced. */
  capped: boolean;
}

/**
 * Clamps a client-reported solo run to what is plausible: the duration to the wall-clock time
 * since the run was started, and everything else to per-minute rates of that duration.
 */
export function capRunStats(claim: RunStats, caps: RunCaps, elapsedS: number): CappedRun {
  const durationS = Math.max(0, Math.min(claim.durationS, Math.floor(elapsedS), caps.maxDurationS));
  const minutes = durationS / 60;
  const limit = (flat: number, perMinute: number) => Math.floor(flat + perMinute * minutes);

  const shinyLimit = Math.min(caps.shiniesMax, limit(caps.shiniesFlat, caps.shiniesPerMinute));
  const stats: RunStats = {
    durationS,
    level: Math.min(claim.level, caps.maxLevel),
    kills: Math.min(claim.kills, limit(0, caps.killsPerMinute)),
    bosses: Math.min(claim.bosses, limit(0, caps.bossesPerMinute)),
    coins: Math.min(claim.coins, limit(caps.coinsFlat, caps.coinsPerMinute)),
    ticketsX1: Math.min(claim.ticketsX1, limit(caps.ticketsX1Flat, caps.ticketsX1PerMinute)),
    ticketsX10: Math.min(claim.ticketsX10, limit(caps.ticketsX10Flat, caps.ticketsX10PerMinute)),
    shiniesCaught: [...new Set(claim.shiniesCaught)].slice(0, Math.max(0, shinyLimit)),
  };
  const capped =
    (Object.keys(stats) as (keyof RunStats)[]).some(
      (key) => key !== 'shiniesCaught' && stats[key] !== claim[key],
    ) || stats.shiniesCaught.length !== claim.shiniesCaught.length;
  return { stats, capped };
}
