// What a run leaves behind, per player: for coin rewards, records, missions and achievements.
import type { RunSummary as ProtocolRunSummary } from '@pokesurvivor/protocol';
import type { Ctx } from './ctx.js';
import type { ProgressTotals, RunEnd, TeamState } from './state.js';

/** Deep copy of plain state data. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface PlayerSummary {
  playerId: string;
  dex: number;
  shiny: boolean;
  /** Left before the end (the reward rules may treat them differently). */
  left: boolean;
  /** Team values, as everyone shared them in legacy co-op. */
  level: number;
  kills: number;
  bosses: number;
  coinsCollected: number;
  tickets: number;
  tickets10: number;
  /** Shiny wild Pokémon defeated this run (each player gets them). */
  shinies: number[];
  /**
   * End-of-run coins as legacy computed them: (seconds / 5 + defeated / 4 + 80 per boss + coins
   * picked up) × this player's coin multiplier (Fortune upgrade, Amulet Coin).
   */
  rewardCoins: number;
  /** Breakdown of `rewardCoins` before the multiplier. */
  rewardParts: { time: number; defeated: number; bosses: number; collected: number };
  coinMul: number;
  moves: { id: string; level: number; evolved: boolean }[];
  item: string | null;
  damageDealt: number;
  lastHits: number;
  timesDown: number;
  revivesGiven: number;
  progress: ProgressTotals;
}

export interface RunSummary {
  /** Seconds played. */
  time: number;
  ended: RunEnd | null;
  /** More than one player took part. */
  group: boolean;
  team: TeamState;
  players: PlayerSummary[];
}

export function runSummary(ctx: Ctx): RunSummary {
  const { s } = ctx;
  const team = s.team;
  const parts = {
    time: Math.floor(s.time / 5),
    defeated: Math.floor(team.kills * 0.25),
    bosses: team.bosses * 80,
    collected: team.coins,
  };
  const base = parts.time + parts.defeated + parts.bosses + parts.collected;
  return {
    time: s.time,
    ended: s.ended,
    group: s.players.length > 1,
    team: clone(team),
    players: s.players.map((p) => ({
      playerId: p.id,
      dex: p.dex,
      shiny: p.shiny,
      left: p.left,
      level: team.level,
      kills: team.kills,
      bosses: team.bosses,
      coinsCollected: team.coins,
      tickets: team.tickets,
      tickets10: team.tickets10,
      shinies: [...team.shinies],
      rewardCoins: Math.round(base * p.coinMul),
      rewardParts: { ...parts },
      coinMul: p.coinMul,
      moves: p.moves.map((m) => ({ id: m.id, level: m.level, evolved: m.evolved })),
      item: p.item,
      damageDealt: p.stats.damageDealt,
      lastHits: p.stats.lastHits,
      timesDown: p.stats.timesDown,
      revivesGiven: p.stats.revivesGiven,
      progress: clone(p.stats.progress),
    })),
  };
}

/**
 * One player's result in the protocol's shape (`packages/protocol` `RunSummary`): what solo
 * clients send to `POST /api/runs` and what the server's co-op rooms pass to `recordCoopRun()`.
 */
export function playerRunSummary(summary: RunSummary, playerId: string): ProtocolRunSummary {
  const p = summary.players.find((x) => x.playerId === playerId);
  if (!p) throw new Error(`no player ${playerId} in the run`);
  const pr = p.progress;
  return {
    durationS: Math.floor(summary.time),
    level: p.level,
    kills: p.kills,
    bosses: p.bosses,
    coins: p.rewardCoins,
    ticketsX1: p.tickets,
    ticketsX10: p.tickets10,
    shiniesCaught: [...p.shinies],
    progress: {
      defeatsByType: { ...pr.defeatsByType },
      chestsOpened: pr.chestsOpened,
      itemsEquipped: [...pr.itemsEquipped],
      movesEvolved: [...pr.movesEvolved],
      riftWins: [...pr.riftWins],
      legendariesDefeated: [...pr.legendariesDefeated],
      rescued: [...pr.rescued],
    },
  };
}
