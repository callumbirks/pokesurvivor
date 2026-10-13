import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Executor } from '../db/index.js';

export type LeaderboardMode = 'solo' | 'group';
export type LeaderboardPeriod = 'daily' | 'weekly' | 'all';

export interface LeaderboardQuery {
  mode: LeaderboardMode;
  period: LeaderboardPeriod;
  /** Only the viewer and their friends (solo), or teams with at least one of them (group). */
  friendsOnly: boolean;
  /** Only runs where this Pokémon was played. */
  pokemonDex?: number;
  limit: number;
  /** The logged-in viewer, to return their own best entry even outside the top. */
  viewerId: string | null;
  /** Days and ISO weeks start at midnight in this IANA time zone. */
  timeZone: string;
}

export interface LeaderboardEntry {
  rank: number;
  durationS: number;
  endedAt: string;
  players: {
    username: string;
    pokemon: { dex: number; shiny: boolean };
    level: number;
    kills: number;
  }[];
}

export interface Leaderboard {
  entries: LeaderboardEntry[];
  /** The viewer's best entry (and rank) on this board, if they have one. */
  me: LeaderboardEntry | null;
}

interface Row extends Record<string, unknown> {
  rank: number;
  duration_s: number;
  ended_at: Date | string;
  players: LeaderboardEntry['players'];
  mine: boolean;
}

function periodStart(period: LeaderboardPeriod, timeZone: string): SQL | undefined {
  if (period === 'all') return undefined;
  const unit = period === 'daily' ? 'day' : 'week';
  return sql`date_trunc(${unit}, now() at time zone ${timeZone}) at time zone ${timeZone}`;
}

/** True if `userCol` is the viewer or one of their accepted friends. */
function isViewerOrFriend(userCol: SQL, viewerId: string): SQL {
  return sql`(${userCol} = ${viewerId} or exists (
    select 1 from friendships f where f.status = 'accepted' and (
      (f.requester_id = ${viewerId} and f.addressee_id = ${userCol}) or
      (f.addressee_id = ${viewerId} and f.requester_id = ${userCol}))))`;
}

/** Players of run `runCol`, as a JSON array for `LeaderboardEntry.players`. */
function playersJson(runCol: SQL): SQL {
  return sql`(select json_agg(json_build_object(
      'username', u.username,
      'pokemon', json_build_object('dex', p.pokemon_dex, 'shiny', p.pokemon_shiny),
      'level', p.level, 'kills', p.kills) order by lower(u.username))
    from run_players p join users u on u.id = p.user_id where p.run_id = ${runCol})`;
}

/**
 * Best survival time per player (solo) or per team (group, one entry per exact set of players),
 * ranked with ties sharing a rank.
 */
export async function getLeaderboard(db: Executor, q: LeaderboardQuery): Promise<Leaderboard> {
  if (q.friendsOnly && !q.viewerId) throw new Error('friendsOnly needs a viewer');
  const since = periodStart(q.period, q.timeZone);
  const filters: SQL[] = [
    sql`r.mode = ${q.mode === 'solo' ? 'solo' : 'coop'}`,
    sql`r.status = 'finished'`,
  ];
  if (since) filters.push(sql`r.ended_at >= ${since}`);

  // One player per solo run, so solo filters can use its row directly; group filters ask
  // whether any player matches.
  const anyPlayer = (cond: SQL) =>
    sql`exists (select 1 from run_players fp where fp.run_id = r.id and ${cond})`;
  if (q.pokemonDex !== undefined) filters.push(anyPlayer(sql`fp.pokemon_dex = ${q.pokemonDex}`));
  if (q.friendsOnly && q.viewerId)
    filters.push(anyPlayer(isViewerOrFriend(sql`fp.user_id`, q.viewerId)));

  // A solo run's team key is its player's id, so "best per team" is "best per player" too.
  const viewerInRun = q.viewerId
    ? sql`exists (select 1 from run_players vp where vp.run_id = ranked.id and vp.user_id = ${q.viewerId})`
    : sql`false`;
  const rows = await db.execute<Row>(sql`
    with best as (
      select distinct on (r.team_key) r.id, r.duration_s, r.ended_at
      from runs r
      where ${sql.join(filters, sql` and `)}
      order by r.team_key, r.duration_s desc, r.ended_at asc
    ), ranked as (
      select best.*, rank() over (order by duration_s desc)::int as rank from best
    )
    select ranked.rank, ranked.duration_s, ranked.ended_at,
           ${playersJson(sql`ranked.id`)} as players,
           ${viewerInRun} as mine
    from ranked
    where ranked.rank <= ${q.limit} or ${viewerInRun}
    order by ranked.rank, ranked.ended_at
  `);

  const toEntry = (r: Row): LeaderboardEntry => ({
    rank: r.rank,
    durationS: r.duration_s,
    endedAt: new Date(r.ended_at).toISOString(),
    players: r.players,
  });
  const entries = rows
    .filter((r) => r.rank <= q.limit)
    .slice(0, q.limit)
    .map(toEntry);
  const mine = rows.find((r) => r.mine);
  return { entries, me: mine ? toEntry(mine) : null };
}
