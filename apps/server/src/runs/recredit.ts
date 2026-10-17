// Re-credits co-op runs whose recording failed, from the server's log lines (v17: games saved by
// v16 and restored counted gems as NaN, and `recordCoopRun` rolled back the whole team). Each
// `recording a coop run failed` line has the failed `run_players` insert (`err.query`,
// `err.params`): every player's stats. They are credited through `recordCoopRun`, like the
// original attempt. See docs/deploy.md ("Re-crediting failed co-op runs") for the command.
import { createHash } from 'node:crypto';
import type { RunProgress } from '@pokesurvivor/protocol';
import { and, between, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { getServerData } from '../data.js';
import type { Executor } from '../db/index.js';
import { runs, saves, users } from '../db/schema.js';
import { recordCoopRun, type CoopRunReport } from './service.js';

const FAILED = 'recording a coop run failed';
/** `run_players` columns in schema order: the fallback when a line has no `err.query`. */
const COLUMNS = [
  'run_id',
  'user_id',
  'pokemon_dex',
  'pokemon_shiny',
  'level',
  'kills',
  'bosses',
  'coins',
  'tickets_x1',
  'tickets_x10',
  'gems',
  'shinies_caught',
  'progress',
];
/** A team run ending this close to a failure means a retry was credited after all. */
const CREDITED_WINDOW_MS = 10 * 60_000;

export interface FailedPlayer {
  userId: string;
  pokemon: { dex: number; shiny: boolean };
  level: number;
  kills: number;
  bosses: number;
  coins: number;
  ticketsX1: number;
  ticketsX10: number;
  shiniesCaught: number[];
  progress: RunProgress;
}

/** One game whose recording failed (all its retries), as the logs have it. */
export interface FailedGame {
  gameId: string;
  roomId: string | null;
  /** The first failure's log time: the run's end, as near as the logs tell. */
  failedAt: Date;
  /** The database error of the first failure. */
  error: string;
  players: FailedPlayer[];
}

export interface ParsedLog {
  games: FailedGame[];
  /** Matching lines that couldn't be read, with why. */
  unreadable: { line: number; reason: string }[];
  /** Failure lines that repeated a game (its retries). */
  duplicates: number;
}

type Row = Record<string, unknown>;

/** `run_players` rows from an insert's SQL and params: each `$n` is `params[n - 1]`. */
function rowsOf(query: string | undefined, params: unknown[]): Row[] {
  const m = query && /insert into "run_players" \(([^)]*)\) values (.*)$/s.exec(query);
  if (!m) {
    if (params.length % COLUMNS.length !== 0)
      throw new Error(`${params.length} params don't fit ${COLUMNS.length} columns per player`);
    const out: Row[] = [];
    for (let i = 0; i < params.length; i += COLUMNS.length)
      out.push(Object.fromEntries(COLUMNS.map((c, j) => [c, params[i + j]])));
    return out;
  }
  const columns = m[1]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  return [...m[2]!.matchAll(/\(([^()]*)\)/g)].map((tuple) => {
    const values = tuple[1]!.split(',').map((v) => v.trim());
    if (values.length !== columns.length) throw new Error('a values tuple has the wrong length');
    return Object.fromEntries(
      columns.map((c, j) => {
        const ref = /^\$(\d+)$/.exec(values[j]!);
        return [c, ref ? params[Number(ref[1]) - 1] : undefined];
      }),
    );
  });
}

function int(row: Row, column: string): number {
  const v = Number(row[column]);
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`bad ${column}: ${String(row[column])}`);
  return v;
}

/** `{133,25}` (a Postgres array literal, as drizzle sends it) or a JSON array. */
function intArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  if (v === null || v === undefined) return [];
  if (typeof v !== 'string') throw new Error(`bad shinies_caught: ${JSON.stringify(v)}`);
  const s = v.replace(/^\{|\}$/g, '');
  const dexes = s ? s.split(',').map(Number) : [];
  if (!dexes.every((d) => Number.isSafeInteger(d) && d > 0))
    throw new Error(`bad shinies_caught: ${v}`);
  return dexes;
}

function player(row: Row): FailedPlayer {
  const userId = row.user_id;
  if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId))
    throw new Error(`bad user_id: ${JSON.stringify(userId)}`);
  const progress = (
    typeof row.progress === 'string' ? JSON.parse(row.progress) : row.progress
  ) as RunProgress;
  if (!progress || typeof progress !== 'object') throw new Error('no progress');
  return {
    userId,
    pokemon: {
      dex: int(row, 'pokemon_dex'),
      shiny: row.pokemon_shiny === true || row.pokemon_shiny === 'true',
    },
    level: int(row, 'level'),
    kills: int(row, 'kills'),
    bosses: int(row, 'bosses'),
    coins: int(row, 'coins'),
    ticketsX1: int(row, 'tickets_x1'),
    ticketsX10: int(row, 'tickets_x10'),
    shiniesCaught: intArray(row.shinies_caught),
    progress,
  };
}

/**
 * The failed co-op recordings in a log (JSON lines; anything else is ignored), one per game:
 * every retry of a game is the same team and stats, under a new run id each time.
 */
export function parseFailedRecordings(text: string): ParsedLog {
  const byGame = new Map<string, FailedGame>();
  const unreadable: ParsedLog['unreadable'] = [];
  let duplicates = 0;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith('{') || !line.includes(FAILED)) return;
    try {
      const entry = JSON.parse(line) as {
        msg?: string;
        time?: number;
        gameId?: string;
        roomId?: string;
        err?: {
          query?: string;
          params?: unknown[];
          message?: string;
          cause?: { message?: string };
        };
      };
      if (entry.msg !== FAILED) return;
      if (!entry.gameId) throw new Error('no gameId');
      if (!Array.isArray(entry.err?.params)) throw new Error('no err.params');
      const players = rowsOf(entry.err.query, entry.err.params).map(player);
      if (!players.length) throw new Error('no players');
      const failedAt = new Date(entry.time ?? NaN);
      if (Number.isNaN(failedAt.getTime())) throw new Error('no time');
      const known = byGame.get(entry.gameId);
      if (known) {
        duplicates++;
        if (failedAt < known.failedAt) known.failedAt = failedAt;
        return;
      }
      byGame.set(entry.gameId, {
        gameId: entry.gameId,
        roomId: entry.roomId ?? null,
        failedAt,
        error: entry.err.cause?.message ?? entry.err.message?.split('\n').at(-1) ?? '',
        players,
      });
    } catch (err) {
      unreadable.push({ line: i + 1, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  return { games: [...byGame.values()], unreadable, duplicates };
}

/** The run id a re-credited game gets: the same for every attempt, so a second one skips it. */
export function recreditRunId(gameId: string): string {
  const h = createHash('sha256').update(`recredit:${gameId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type GameOutcome =
  | {
      kind: 'credit';
      runId: string;
      players: (FailedPlayer & { username: string })[];
      missing: string[];
    }
  | { kind: 'already'; runId: string; reason: string }
  | { kind: 'nobody'; missing: string[] };

export interface RecreditResult {
  game: FailedGame;
  outcome: GameOutcome;
}

/**
 * What re-crediting each game does, and with `apply`, does it: each game in its own transaction
 * through `recordCoopRun` (run row, `run_players`, ledger, collection, stats, missions,
 * achievements). Skips games already re-credited (their `recreditRunId` exists) or credited by a
 * retry (a co-op run of the same team ending near the failure). Players without a save (deleted
 * accounts) are left out. What the logs don't have: gems (credited 0), the duration (0: no best
 * time, minutes missions or leaderboard time), early leavers (everyone counts as staying), the
 * config version (0). The run ends at the failure's log time; missions count for today.
 */
export async function recreditGames(
  db: Executor,
  games: FailedGame[],
  opts: { apply: boolean; timeZone: string; log?: Pick<FastifyBaseLogger, 'warn'> },
): Promise<RecreditResult[]> {
  const results: RecreditResult[] = [];
  for (const game of games) {
    const runId = recreditRunId(game.gameId);
    const teamKey = [...game.players.map((p) => p.userId)].sort().join(',');
    const [done] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
    if (done) {
      results.push({ game, outcome: { kind: 'already', runId, reason: 're-credited before' } });
      continue;
    }
    const at = game.failedAt.getTime();
    const [retried] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.mode, 'coop'),
          eq(runs.teamKey, teamKey),
          between(
            runs.endedAt,
            new Date(at - CREDITED_WINDOW_MS),
            new Date(at + CREDITED_WINDOW_MS),
          ),
        ),
      );
    if (retried) {
      const reason = 'a co-op run of this team ended near the failure';
      results.push({ game, outcome: { kind: 'already', runId: retried.id, reason } });
      continue;
    }
    const ids = game.players.map((p) => p.userId);
    const found = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .innerJoin(saves, eq(saves.userId, users.id))
      .where(inArray(users.id, ids));
    const names = new Map(found.map((u) => [u.id, u.username]));
    const missing = ids.filter((id) => !names.has(id));
    const players = game.players
      .filter((p) => names.has(p.userId))
      .map((p) => ({ ...p, username: names.get(p.userId)! }));
    if (!players.length) {
      results.push({ game, outcome: { kind: 'nobody', missing } });
      continue;
    }
    if (opts.apply) {
      const report: CoopRunReport = {
        runId,
        gameId: game.gameId,
        startedAt: game.failedAt,
        endedAt: game.failedAt,
        durationS: 0,
        configVersion: 0,
        players: players.map(({ username: _, ...p }) => ({ ...p, gems: 0 })),
      };
      await recordCoopRun(
        db,
        report,
        { timeZone: opts.timeZone, missionsAt: new Date() },
        { log: opts.log },
      );
    }
    results.push({ game, outcome: { kind: 'credit', runId, players, missing } });
  }
  return results;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function progressSummary(p: RunProgress): string {
  const defeats = Object.values(p.defeatsByType).reduce<number>((a, n) => a + (n ?? 0), 0);
  const parts = [
    `${defeats} type defeats`,
    p.chestsOpened && plural(p.chestsOpened, 'chest'),
    p.itemsEquipped.length && plural(p.itemsEquipped.length, 'item'),
    p.movesEvolved.length && plural(p.movesEvolved.length, 'evolution'),
    p.riftWins.length && plural(p.riftWins.length, 'rift win'),
    p.legendariesDefeated.length &&
      plural(p.legendariesDefeated.length, 'legendary', 'legendaries'),
    p.rescued.length && plural(p.rescued.length, 'rescue'),
  ];
  return parts.filter(Boolean).join(', ');
}

/** The dry run's (or the applied run's) report, one block per game, then the totals. */
export function formatResults(
  parsed: ParsedLog,
  results: RecreditResult[],
  apply: boolean,
): string {
  const data = getServerData();
  const out: string[] = [];
  const verb = apply ? 'credited' : 'would credit';
  const totals = { games: 0, players: 0, coins: 0, tickets: 0, tickets10: 0 };
  for (const { game, outcome } of results) {
    const head = `game ${game.gameId} (room ${game.roomId ?? '?'}), failed ${game.failedAt.toISOString()}`;
    if (outcome.kind === 'already') {
      out.push(`${head}: skipped, ${outcome.reason} (run ${outcome.runId})`);
      continue;
    }
    if (outcome.kind === 'nobody') {
      out.push(`${head}: skipped, no player has a save (${outcome.missing.join(', ')})`);
      continue;
    }
    totals.games++;
    out.push(`${head}: ${verb} as run ${outcome.runId}`);
    out.push(`  error: ${game.error}`);
    for (const p of outcome.players) {
      totals.players++;
      totals.coins += p.coins;
      totals.tickets += p.ticketsX1;
      totals.tickets10 += p.ticketsX10;
      const mon = `${data.pokemonByDex.get(p.pokemon.dex)?.name ?? `#${p.pokemon.dex}`}${p.pokemon.shiny ? ' ✨' : ''}`;
      out.push(
        `  ${p.username} (${mon}): +${p.coins} coins, +${p.ticketsX1} tickets, +${p.ticketsX10} ×10, 0 gems; ` +
          `level ${p.level}, ${p.kills} defeated, ${plural(p.bosses, 'boss', 'bosses')}` +
          (p.shiniesCaught.length ? `, shinies ${p.shiniesCaught.join(' ')}` : '') +
          `; progress: ${progressSummary(p.progress)}`,
      );
    }
    for (const id of outcome.missing) out.push(`  left out: user ${id} has no save`);
  }
  for (const u of parsed.unreadable) out.push(`line ${u.line}: unreadable, ${u.reason}`);
  out.push(
    `${apply ? 'Credited' : 'Would credit'} ${plural(totals.games, 'game')}, ${plural(totals.players, 'player')}: ` +
      `${totals.coins} coins, ${totals.tickets} tickets, ${totals.tickets10} ×10 tickets, 0 gems. ` +
      `${plural(results.length - totals.games, 'game')} skipped, ${plural(parsed.duplicates, 'retry line')} merged.` +
      (apply ? '' : ' Dry run: nothing was written; add --apply to credit.'),
  );
  return out.join('\n');
}
