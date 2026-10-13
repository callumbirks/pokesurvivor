import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../db/index.js';
import { runPlayers, runs } from '../db/schema.js';
import type { RunCaps } from '../economy/config.js';
import { ApiError } from '../http/errors.js';
import { ownsPokemon, withLockedSave } from '../saves/service.js';
import type { LockedSave } from '../saves/service.js';
import { capRunStats } from './caps.js';
import type { RunStats } from './caps.js';

export type RunMode = 'solo' | 'coop';

export interface RunPokemon {
  dex: number;
  shiny: boolean;
}

/** What was credited for a finished run. */
export interface RunResult {
  runId: string;
  stats: RunStats;
  /** True if the client's claim was reduced by the sanity caps. */
  capped: boolean;
}

/**
 * Credits a player's run rewards to their locked save and updates their stats: coins and
 * tickets through the ledger, caught wild shinies (and the normal form) into the collection.
 */
function applyRunToSave(save: LockedSave, runId: string, mode: RunMode, stats: RunStats): void {
  const { wallet, data } = save;
  wallet.credit('coins', stats.coins, 'run_reward', runId);
  wallet.credit('tickets_x1', stats.ticketsX1, 'run_reward', runId);
  wallet.credit('tickets_x10', stats.ticketsX10, 'run_reward', runId);

  const now = Date.now();
  for (const dex of stats.shiniesCaught) {
    const key = String(dex);
    data.owned[key] ??= { at: now, from: 'wild' };
    data.shiny[key] ??= { at: now, from: 'wild' };
  }

  const s = data.stats;
  s.runs += 1;
  s.bestTimeS = Math.max(s.bestTimeS, stats.durationS);
  if (mode === 'coop') {
    s.groupRuns += 1;
    s.bestGroupTimeS = Math.max(s.bestGroupTimeS, stats.durationS);
  }
  s.bestLevel = Math.max(s.bestLevel, stats.level);
  s.totalKills += stats.kills;
  s.bossesTotal += stats.bosses;
  s.coinsEarned += stats.coins;
  s.shinies += stats.shiniesCaught.length;
  // Missions and achievements progress from runs once their definitions are in packages/data.
}

function playerColumns(stats: Omit<RunStats, 'durationS'>) {
  return {
    level: stats.level,
    kills: stats.kills,
    bosses: stats.bosses,
    coins: stats.coins,
    ticketsX1: stats.ticketsX1,
    ticketsX10: stats.ticketsX10,
    shiniesCaught: stats.shiniesCaught,
  };
}

/** Starts a solo run with one of the player's Pokémon. The client reports it with `finishSoloRun`. */
export async function startSoloRun(
  db: Executor,
  userId: string,
  pokemon: RunPokemon,
): Promise<{ runId: string; startedAt: Date }> {
  return db.transaction(async (tx) => {
    // Read under the save lock so the ownership check can't race a change to the save.
    await withLockedSave(tx, userId, (save) => {
      if (!ownsPokemon(save.data, pokemon.dex, pokemon.shiny))
        throw new ApiError(409, 'pokemon_not_owned', `Pokémon ${pokemon.dex} is not owned`);
    });
    const [run] = await tx
      .insert(runs)
      .values({ mode: 'solo', status: 'started', teamKey: userId })
      .returning({ id: runs.id, startedAt: runs.startedAt });
    if (!run) throw new Error('insert returned no row');
    await tx.insert(runPlayers).values({
      runId: run.id,
      userId,
      pokemonDex: pokemon.dex,
      pokemonShiny: pokemon.shiny,
    });
    return { runId: run.id, startedAt: run.startedAt };
  });
}

/**
 * Finishes a solo run from the client's summary: caps it (see `capRunStats`), stores it and
 * credits the capped rewards. A run can be finished once.
 */
export async function finishSoloRun(
  db: Executor,
  userId: string,
  runId: string,
  claim: RunStats,
  caps: RunCaps,
): Promise<RunResult> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        status: runs.status,
        elapsedS: sql<number>`extract(epoch from now() - ${runs.startedAt})::float8`,
      })
      .from(runs)
      .innerJoin(runPlayers, eq(runPlayers.runId, runs.id))
      .where(and(eq(runs.id, runId), eq(runs.mode, 'solo'), eq(runPlayers.userId, userId)))
      .for('update', { of: runs });
    if (!run) throw new ApiError(404, 'run_not_found', `No solo run ${runId} for this user`);
    if (run.status !== 'started')
      throw new ApiError(409, 'run_already_finished', `Run ${runId} was already reported`);

    const { stats, capped } = capRunStats(claim, caps, run.elapsedS);
    await tx
      .update(runs)
      .set({ status: 'finished', endedAt: sql`now()`, durationS: stats.durationS })
      .where(eq(runs.id, runId));
    await tx
      .update(runPlayers)
      .set({ ...playerColumns(stats), claimed: capped ? claim : null })
      .where(and(eq(runPlayers.runId, runId), eq(runPlayers.userId, userId)));
    await withLockedSave(tx, userId, (save) => applyRunToSave(save, runId, 'solo', stats));
    return { runId, stats, capped };
  });
}

export interface CoopRunReport {
  startedAt: Date;
  endedAt: Date;
  durationS: number;
  players: (Omit<RunStats, 'durationS'> & { userId: string; pokemon: RunPokemon })[];
}

/**
 * Records a coop run reported by the game server's own simulation (not by clients, so it isn't
 * capped) and credits every player, all in one transaction. For the room manager (phase 3c);
 * there is deliberately no HTTP endpoint for it.
 */
export async function recordCoopRun(db: Executor, report: CoopRunReport): Promise<string> {
  if (report.players.length === 0) throw new Error('A coop run needs at least one player');
  // Lock saves in a stable order so concurrent reports can't deadlock.
  const players = [...report.players].sort((a, b) => a.userId.localeCompare(b.userId));
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        mode: 'coop',
        status: 'finished',
        teamKey: players.map((p) => p.userId).join(','),
        startedAt: report.startedAt,
        endedAt: report.endedAt,
        durationS: report.durationS,
      })
      .returning({ id: runs.id });
    if (!run) throw new Error('insert returned no row');
    await tx.insert(runPlayers).values(
      players.map((p) => ({
        runId: run.id,
        userId: p.userId,
        pokemonDex: p.pokemon.dex,
        pokemonShiny: p.pokemon.shiny,
        ...playerColumns(p),
      })),
    );
    for (const player of players) {
      const stats = { ...player, durationS: report.durationS };
      await withLockedSave(tx, player.userId, (save) =>
        applyRunToSave(save, run.id, 'coop', stats),
      );
    }
    return run.id;
  });
}
