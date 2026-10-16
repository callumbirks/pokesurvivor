// The admin run export (R11, docs/run-export.md): finished runs' balance records with their run,
// player and config version, filtered, as one JSON file streamed page by page.
import { Readable } from 'node:stream';
import { and, asc, eq, gt, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks } from '../auth/plugin.js';
import type { Database } from '../db/index.js';
import { configVersions, runBalance, runPlayers, runs, users } from '../db/schema.js';
import { parseBody } from '../http/errors.js';

export interface RunExportRoutesOptions {
  db: Database;
  secureCookies: boolean;
}

/** Rows read per page while streaming. */
const PAGE = 500;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** The export's filters (query string); all optional. */
export const exportFilters = z.object({
  /** Runs that ended in [from, to] (ISO dates or times). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Run duration bounds, in seconds (`minDurationS=1200`: runs that reached 20:00). */
  minDurationS: z.coerce.number().int().nonnegative().optional(),
  maxDurationS: z.coerce.number().int().nonnegative().optional(),
  mode: z.enum(['solo', 'coop']).optional(),
  /** Players in the run. */
  players: z.coerce.number().int().min(1).max(4).optional(),
  /** The player's Pokémon. */
  dex: z.coerce.number().int().nonnegative().optional(),
  /** The player (case-insensitive). */
  username: z.string().trim().min(1).max(32).optional(),
  configVersion: z.coerce.number().int().nonnegative().optional(),
  /** How the run ended (`none`: no end recorded, e.g. a server shutdown or a timeout credit). */
  outcome: z.enum(['all-down', 'everyone-left', 'none']).optional(),
  /** Include records with implausibility flags (default: leave them out). */
  includeFlagged: bool.default(false),
});
export type ExportFilters = z.infer<typeof exportFilters>;

const playerCount = sql<number>`(select count(*)::int from ${runPlayers} rp where rp.run_id = ${runs.id})`;
const reason = sql`${runBalance.record} -> 'end' ->> 'reason'`;

/** The where clause of the filters (`flags: false` ignores `includeFlagged`). */
function where(f: ExportFilters, flags = true): SQL | undefined {
  const c: (SQL | undefined)[] = [eq(runs.status, 'finished')];
  if (f.from) c.push(gte(runs.endedAt, f.from));
  if (f.to) c.push(lte(runs.endedAt, f.to));
  if (f.minDurationS !== undefined) c.push(gte(runs.durationS, f.minDurationS));
  if (f.maxDurationS !== undefined) c.push(lte(runs.durationS, f.maxDurationS));
  if (f.mode) c.push(eq(runs.mode, f.mode));
  if (f.players !== undefined) c.push(sql`${playerCount} = ${f.players}`);
  if (f.dex !== undefined) c.push(eq(runPlayers.pokemonDex, f.dex));
  if (f.username) c.push(sql`lower(${users.username}) = lower(${f.username})`);
  if (f.configVersion !== undefined) c.push(eq(runs.configVersion, f.configVersion));
  if (f.outcome === 'none') c.push(sql`${reason} is null`);
  else if (f.outcome) c.push(sql`${reason} = ${f.outcome}`);
  if (flags && !f.includeFlagged) c.push(sql`cardinality(${runBalance.flags}) = 0`);
  return and(...c);
}

/** The joined rows the export reads. */
function rows(db: Database) {
  return db
    .select({
      runId: runs.id,
      mode: runs.mode,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationS: runs.durationS,
      timedOut: runs.timedOut,
      configVersion: runs.configVersion,
      players: playerCount,
      userId: runBalance.userId,
      username: users.username,
      dex: runPlayers.pokemonDex,
      shiny: runPlayers.pokemonShiny,
      level: runPlayers.level,
      kills: runPlayers.kills,
      bosses: runPlayers.bosses,
      coins: runPlayers.coins,
      ticketsX1: runPlayers.ticketsX1,
      ticketsX10: runPlayers.ticketsX10,
      gems: runPlayers.gems,
      source: runBalance.source,
      flags: runBalance.flags,
      record: runBalance.record,
    })
    .from(runBalance)
    .innerJoin(
      runPlayers,
      and(eq(runPlayers.runId, runBalance.runId), eq(runPlayers.userId, runBalance.userId)),
    )
    .innerJoin(runs, eq(runs.id, runBalance.runId))
    .innerJoin(users, eq(users.id, runBalance.userId));
}

type Row = Awaited<ReturnType<ReturnType<typeof rows>['execute']>>[number];

/** One export entry: the run, the player (as credited) and their balance record. */
function entry(r: Row) {
  return {
    run: {
      id: r.runId,
      mode: r.mode,
      players: r.players,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      durationS: r.durationS,
      timedOut: r.timedOut,
      configVersion: r.configVersion,
    },
    player: {
      userId: r.userId,
      username: r.username,
      dex: r.dex,
      shiny: r.shiny,
      credited: {
        level: r.level,
        kills: r.kills,
        bosses: r.bosses,
        coins: r.coins,
        ticketsX1: r.ticketsX1,
        ticketsX10: r.ticketsX10,
        gems: r.gems,
      },
    },
    source: r.source,
    flags: r.flags,
    balance: r.record,
  };
}

/** How many records match: with the flagged ones counted apart. */
export async function countExport(db: Database, f: ExportFilters) {
  const [c] = await db
    .select({
      total: sql<number>`count(*)::int`,
      flagged: sql<number>`(count(*) filter (where cardinality(${runBalance.flags}) > 0))::int`,
    })
    .from(runBalance)
    .innerJoin(
      runPlayers,
      and(eq(runPlayers.runId, runBalance.runId), eq(runPlayers.userId, runBalance.userId)),
    )
    .innerJoin(runs, eq(runs.id, runBalance.runId))
    .innerJoin(users, eq(users.id, runBalance.userId))
    .where(where(f, false));
  const total = c?.total ?? 0;
  const flagged = c?.flagged ?? 0;
  return { count: f.includeFlagged ? total : total - flagged, flagged };
}

/**
 * The export as JSON text, page by page: `{ exportedAt, filters, entries: [...], configVersions }`,
 * where `configVersions` has the overrides of each version the entries played with.
 */
export async function* exportJson(
  db: Database,
  f: ExportFilters,
  pageSize = PAGE,
): AsyncGenerator<string> {
  yield `{"exportedAt":${JSON.stringify(new Date().toISOString())},"filters":${JSON.stringify(f)},"entries":[`;
  const versions = new Set<number>();
  let after: { endedAt: Date; runId: string; userId: string } | null = null;
  let first = true;
  for (;;) {
    const keyset: SQL | undefined = after
      ? or(
          gt(runs.endedAt, after.endedAt),
          and(eq(runs.endedAt, after.endedAt), gt(runBalance.runId, after.runId)),
          and(
            eq(runs.endedAt, after.endedAt),
            eq(runBalance.runId, after.runId),
            gt(runBalance.userId, after.userId),
          ),
        )
      : undefined;
    const page = await rows(db)
      .where(and(where(f), keyset))
      .orderBy(asc(runs.endedAt), asc(runBalance.runId), asc(runBalance.userId))
      .limit(pageSize);
    for (const r of page) {
      versions.add(r.configVersion);
      yield (first ? '\n' : ',\n') + JSON.stringify(entry(r));
      first = false;
    }
    const last = page.at(-1);
    if (page.length < pageSize || !last?.endedAt) break;
    after = { endedAt: last.endedAt, runId: last.runId, userId: last.userId };
  }
  const configs = versions.size
    ? await db
        .select({
          id: configVersions.id,
          createdAt: configVersions.createdAt,
          note: configVersions.note,
          overrides: configVersions.overrides,
        })
        .from(configVersions)
        .where(inArray(configVersions.id, [...versions]))
    : [];
  const byId = Object.fromEntries(
    configs.map((c) => [
      c.id,
      { createdAt: c.createdAt.toISOString(), note: c.note, overrides: c.overrides },
    ]),
  );
  yield `\n],"configVersions":${JSON.stringify(byId)}}\n`;
}

export function runExportRoutes(app: FastifyInstance, opts: RunExportRoutesOptions): void {
  const { db } = opts;
  const { requireAdmin } = createAuthHooks(opts);

  app.get('/api/admin/runs/count', { preHandler: requireAdmin }, async (request) =>
    countExport(db, parseBody(exportFilters, request.query)),
  );

  app.get('/api/admin/runs/export', { preHandler: requireAdmin }, async (request, reply) => {
    const f = parseBody(exportFilters, request.query);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="pokesurvivor-runs-${stamp}.json"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(exportJson(db, f)));
  });
}
