import type { GameData } from '@pokesurvivor/data';
import type { BalanceRecord } from '@pokesurvivor/protocol';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { pokemonOf } from '../data.js';
import type { Executor } from '../db/index.js';
import { runBalance, runPlayers, runs } from '../db/schema.js';
import type { RunCaps } from '../economy/config.js';
import { ApiError } from '../http/errors.js';
import { checkAchievements } from '../progress/achievements.js';
import type { UnlockedAchievement } from '../progress/achievements.js';
import { advanceMissions, ensureMissions, periodsAt } from '../progress/missions.js';
import { ownsPokemon, withLockedSave } from '../saves/service.js';
import type { LockedSave } from '../saves/service.js';
import { balanceFlags, type BalanceContext } from './balance.js';
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
  /** Achievements the run unlocked. */
  achievements: UnlockedAchievement[];
}

/** Settings that decide how a run counts towards missions. */
export interface ProgressOptions {
  /** Daily and weekly missions roll over at midnight in this time zone. */
  timeZone: string;
}

interface AppliedRun {
  runId: string;
  mode: RunMode;
  stats: RunStats;
  pokemon: RunPokemon;
  endedAt: Date;
}

/**
 * Credits a player's run to their locked save: coins and tickets through the ledger; caught
 * wild shinies (and the normal form) and rescued Pokémon into the collection; stats and the
 * per-run progress (items found, moves evolved, arenas won, legendaries beaten); then missions
 * and achievements (original `progress.js` events, applied once for the whole run).
 */
function applyRunToSave(
  save: LockedSave,
  run: AppliedRun,
  opts: ProgressOptions,
): UnlockedAchievement[] {
  const { wallet, data } = save;
  const { runId, mode, stats } = run;
  const p = stats.progress;
  wallet.credit('coins', stats.coins, 'run_reward', runId);
  wallet.credit('tickets_x1', stats.ticketsX1, 'run_reward', runId);
  wallet.credit('tickets_x10', stats.ticketsX10, 'run_reward', runId);

  const now = run.endedAt.getTime();
  for (const dex of stats.shiniesCaught) {
    const key = String(dex);
    data.owned[key] ??= { at: now, from: 'wild' };
    data.shiny[key] ??= { at: now, from: 'wild' };
  }
  for (const dex of p.rescued) data.owned[String(dex)] ??= { at: now, from: 'rescue' };
  for (const id of p.itemsEquipped) data.itemsFound[id] ??= now;
  for (const id of p.movesEvolved) data.movesEvolved[id] ??= now;
  for (const type of p.riftWins) data.arenasWon[type] ??= now;
  for (const dex of p.legendariesDefeated) data.legendsBeaten[String(dex)] ??= now;

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
  s.evolutions += p.movesEvolved.length;
  s.riftWins += p.riftWins.length;

  ensureMissions(save, periodsAt(run.endedAt, opts.timeZone));
  advanceMissions(data, {
    kind: 'run',
    summary: stats,
    pokemonTypes: pokemonOf(run.pokemon.dex).types,
  });
  return checkAchievements(save, now);
}

/** How balance records are stored: where failures are logged, and each config version's data. */
export interface BalanceOptions {
  log?: Pick<FastifyBaseLogger, 'warn'>;
  /**
   * The game data of a config version (live tuning), to check a record against the config the
   * run played with. Absent, or null for an unknown version: the server's built-in data.
   */
  dataFor?: (version: number) => Promise<GameData | null>;
}

/** A solo run's balance record from the client (already validated by the route), if any. */
export interface SoloBalance extends BalanceOptions {
  record?: BalanceRecord | null;
}

/**
 * Stores (or replaces) a player's balance record for a run, with its implausibility flags. In a
 * savepoint, so a failure is logged and never undoes the run's credit.
 */
async function storeBalance(
  tx: Executor,
  row: { runId: string; userId: string; source: 'server' | 'client'; record: BalanceRecord },
  run: BalanceContext & { configVersion: number },
  opts: BalanceOptions,
): Promise<void> {
  try {
    const game = (await opts.dataFor?.(run.configVersion)) ?? undefined;
    const flags = balanceFlags(row.record, { ...run, game });
    const values = { version: row.record.v, source: row.source, record: row.record, flags };
    await tx.transaction(async (sp) => {
      await sp
        .insert(runBalance)
        .values({ runId: row.runId, userId: row.userId, ...values })
        .onConflictDoUpdate({
          target: [runBalance.runId, runBalance.userId],
          set: { ...values, updatedAt: sql`now()` },
        });
    });
  } catch (err) {
    opts.log?.warn(
      { err, runId: row.runId, userId: row.userId },
      'storing a balance record failed',
    );
  }
}

function playerColumns(stats: Omit<RunStats, 'durationS'>) {
  return {
    progress: stats.progress,
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
  /** The live-tuning config version the server issues the run (`config_versions`). */
  configVersion = 0,
): Promise<{ runId: string; startedAt: Date }> {
  return db.transaction(async (tx) => {
    // Read under the save lock so the ownership check can't race a change to the save.
    await withLockedSave(tx, userId, (save) => {
      if (!ownsPokemon(save.data, pokemon.dex, pokemon.shiny))
        throw new ApiError(409, 'pokemon_not_owned', `Pokémon ${pokemon.dex} is not owned`);
    });
    const [run] = await tx
      .insert(runs)
      .values({ mode: 'solo', status: 'started', teamKey: userId, configVersion })
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

/** Locks a solo run of this player for an update; it must still be open (`started`). */
async function lockOpenSoloRun(tx: Executor, userId: string, runId: string) {
  const [run] = await tx
    .select({
      status: runs.status,
      configVersion: runs.configVersion,
      timedOut: runs.timedOut,
      checkpoint: runPlayers.checkpoint,
      pokemonDex: runPlayers.pokemonDex,
      pokemonShiny: runPlayers.pokemonShiny,
      elapsedS: sql<number>`extract(epoch from now() - ${runs.startedAt})::float8`,
    })
    .from(runs)
    .innerJoin(runPlayers, eq(runPlayers.runId, runs.id))
    .where(and(eq(runs.id, runId), eq(runs.mode, 'solo'), eq(runPlayers.userId, userId)))
    .for('update', { of: runs });
  if (!run) throw new ApiError(404, 'run_not_found', `No solo run ${runId} for this user`);
  if (run.timedOut)
    // What was credited, so a client that comes back to the run can show its results.
    throw new ApiError(
      409,
      'run_credited_by_timeout',
      `Run ${runId} was already credited from its last checkpoint`,
      { credited: run.checkpoint },
    );
  if (run.status !== 'started')
    throw new ApiError(409, 'run_already_finished', `Run ${runId} was already reported`);
  return run;
}

/** A stored checkpoint: what the timeout sweep would credit. */
export interface RunCheckpoint {
  runId: string;
  stats: RunStats;
  capped: boolean;
}

/**
 * Stores a solo run's run-so-far summary as its latest checkpoint, capped like a final report
 * for the time since start. Nothing is credited: `creditTimedOutRuns` credits it if the final
 * report doesn't come within the timeout.
 */
export async function checkpointSoloRun(
  db: Executor,
  userId: string,
  runId: string,
  claim: RunStats,
  caps: RunCaps,
  balance: SoloBalance = {},
): Promise<RunCheckpoint> {
  return db.transaction(async (tx) => {
    const run = await lockOpenSoloRun(tx, userId, runId);
    const { stats, capped } = capRunStats(claim, caps, run.elapsedS);
    if (balance.record)
      await storeBalance(
        tx,
        { runId, userId, source: 'client', record: balance.record },
        { ...claim, dex: run.pokemonDex, capped, configVersion: run.configVersion },
        balance,
      );
    await tx
      .update(runs)
      .set({ checkpointAt: sql`now()` })
      .where(eq(runs.id, runId));
    await tx
      .update(runPlayers)
      .set({ checkpoint: stats, claimed: capped ? claim : null })
      .where(and(eq(runPlayers.runId, runId), eq(runPlayers.userId, userId)));
    return { runId, stats, capped };
  });
}

/**
 * Finishes a solo run from the client's summary: caps it (see `capRunStats`), stores it and
 * credits the capped rewards. A run is credited once: a second report, or one after the
 * timeout sweep credited the run's last checkpoint, is refused (409).
 */
export async function finishSoloRun(
  db: Executor,
  userId: string,
  runId: string,
  claim: RunStats,
  caps: RunCaps,
  opts: ProgressOptions,
  balance: SoloBalance = {},
): Promise<RunResult> {
  return db.transaction(async (tx) => {
    const run = await lockOpenSoloRun(tx, userId, runId);
    const { stats, capped } = capRunStats(claim, caps, run.elapsedS);
    await tx
      .update(runs)
      .set({ status: 'finished', endedAt: sql`now()`, durationS: stats.durationS })
      .where(eq(runs.id, runId));
    await tx
      .update(runPlayers)
      .set({ ...playerColumns(stats), claimed: capped ? claim : null })
      .where(and(eq(runPlayers.runId, runId), eq(runPlayers.userId, userId)));
    const pokemon = { dex: run.pokemonDex, shiny: run.pokemonShiny };
    let setup: BalanceContext['save'];
    const achievements = await withLockedSave(tx, userId, (save) => {
      // What the save allows this Pokémon, to check the record's setup against.
      const key = String(pokemon.dex);
      setup = { prestige: save.data.prestige[key] ?? 0, upgrades: save.data.upgrades[key] ?? {} };
      return applyRunToSave(
        save,
        { runId, mode: 'solo', stats, pokemon, endedAt: new Date() },
        opts,
      );
    });
    if (balance.record)
      await storeBalance(
        tx,
        { runId, userId, source: 'client', record: balance.record },
        {
          ...claim,
          dex: run.pokemonDex,
          capped,
          save: setup,
          configVersion: run.configVersion,
        },
        balance,
      );
    return { runId, stats, capped, achievements };
  });
}

/**
 * Credits every open solo run whose last checkpoint is older than `timeoutMs` (the final report
 * never came: a closed tab, a crash) from that checkpoint, and closes it (`timedOut`). Runs
 * without a checkpoint are left open. Safe to run from several places at once: each run is
 * claimed under a row lock (`skip locked`) and re-checked, so it is credited once, and never
 * after a final report. Returns the ids credited.
 */
export async function creditTimedOutRuns(
  db: Executor,
  timeoutMs: number,
  opts: ProgressOptions,
): Promise<string[]> {
  const credited: string[] = [];
  for (;;) {
    const runId = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({
          id: runs.id,
          checkpointAt: runs.checkpointAt,
          userId: runPlayers.userId,
          pokemonDex: runPlayers.pokemonDex,
          pokemonShiny: runPlayers.pokemonShiny,
          checkpoint: runPlayers.checkpoint,
        })
        .from(runs)
        .innerJoin(runPlayers, eq(runPlayers.runId, runs.id))
        .where(
          and(
            eq(runs.mode, 'solo'),
            eq(runs.status, 'started'),
            lt(runs.checkpointAt, sql`now() - make_interval(secs => ${timeoutMs / 1000})`),
          ),
        )
        .orderBy(runs.checkpointAt)
        .limit(1)
        .for('update', { of: runs, skipLocked: true });
      if (!run?.checkpointAt) return null;
      // Written by `checkpointSoloRun`, already capped.
      const stats = run.checkpoint as RunStats;
      const endedAt = run.checkpointAt;
      await tx
        .update(runs)
        .set({ status: 'finished', timedOut: true, endedAt, durationS: stats.durationS })
        .where(eq(runs.id, run.id));
      await tx
        .update(runPlayers)
        .set(playerColumns(stats))
        .where(and(eq(runPlayers.runId, run.id), eq(runPlayers.userId, run.userId)));
      const pokemon = { dex: run.pokemonDex, shiny: run.pokemonShiny };
      await withLockedSave(tx, run.userId, (save) =>
        applyRunToSave(save, { runId: run.id, mode: 'solo', stats, pokemon, endedAt }, opts),
      );
      return run.id;
    });
    if (!runId) return credited;
    credited.push(runId);
  }
}

export interface CoopRunReport {
  startedAt: Date;
  endedAt: Date;
  durationS: number;
  /** The live-tuning config version the game ran with (0: the defaults). */
  configVersion?: number;
  /**
   * Each player's stats. `leftAfterS`: a player who left before the end played this long (it
   * counts for their best time and missions instead of the run's `durationS`).
   */
  players: (Omit<RunStats, 'durationS'> & {
    userId: string;
    pokemon: RunPokemon;
    leftAfterS?: number;
  })[];
}

/**
 * Records a coop run reported by the game server's own simulation (not by clients, so it isn't
 * capped) and credits every player, all in one transaction. Each player's `progress` advances
 * their missions and achievements like a solo run's. For the room manager (phase 3c);
 * there is deliberately no HTTP endpoint for it. Returns the run id and the achievements each
 * player unlocked (by user id).
 */
export async function recordCoopRun(
  db: Executor,
  report: CoopRunReport,
  opts: ProgressOptions,
  balance: BalanceOptions = {},
): Promise<{ runId: string; achievements: Map<string, UnlockedAchievement[]> }> {
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
        configVersion: report.configVersion ?? 0,
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
    for (const p of players) {
      if (!p.balance) continue;
      const durationS = p.leftAfterS ?? report.durationS;
      await storeBalance(
        tx,
        { runId: run.id, userId: p.userId, source: 'server', record: p.balance },
        {
          durationS,
          level: p.level,
          kills: p.kills,
          dex: p.pokemon.dex,
          configVersion: report.configVersion ?? 0,
        },
        balance,
      );
    }
    const achievements = new Map<string, UnlockedAchievement[]>();
    for (const player of players) {
      const { userId, pokemon, leftAfterS, ...rest } = player;
      const stats = { ...rest, durationS: leftAfterS ?? report.durationS };
      const unlocked = await withLockedSave(tx, userId, (save) =>
        applyRunToSave(
          save,
          { runId: run.id, mode: 'coop', stats, pokemon, endedAt: report.endedAt },
          opts,
        ),
      );
      achievements.set(userId, unlocked);
    }
    return { runId: run.id, achievements };
  });
}
