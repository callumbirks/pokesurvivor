import { emptyRunProgress, type RunProgress } from '@pokesurvivor/protocol';
import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currencyLedger, runPlayers, runs } from '../db/schema.js';
import { periodsAt } from '../progress/missions.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';
import type { SaveView } from '../saves/service.js';
import {
  formatResults,
  parseFailedRecordings,
  recreditGames,
  recreditRunId,
  type FailedGame,
} from './recredit.js';

const TZ = 'Europe/Madrid';

type Player = TestClient & { userId: string };

describe('re-crediting failed co-op runs', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const progress: RunProgress = {
    ...emptyRunProgress(),
    defeatsByType: { water: 300, flying: 80 },
    chestsOpened: 1,
    riftWins: ['fire'],
  };

  /**
   * The log lines of a failed recording, made the way production made them: the `run_players`
   * insert with gems NaN fails, and the server's (Fastify's pino) logger logs the error, once per
   * attempt (each with a new run id).
   */
  async function failedLines(players: Player[], gameId: string, attempts = 3) {
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'info', stream: { write: (s) => lines.push(s) } } });
    for (let i = 0; i < attempts; i++) {
      const err = await t.db.db
        .transaction(async (tx) => {
          const [run] = await tx
            .insert(runs)
            .values({ mode: 'coop', status: 'finished', teamKey: 'x', durationS: 900 })
            .returning({ id: runs.id });
          await tx.insert(runPlayers).values(
            players.map((c, j) => ({
              runId: run!.id,
              userId: c.userId,
              pokemonDex: j ? 1 : 25,
              pokemonShiny: j === 0,
              level: 30 + j,
              kills: 474,
              bosses: 2,
              coins: 243 + j,
              ticketsX1: 2,
              ticketsX10: j,
              gems: NaN,
              shiniesCaught: j ? [] : [133],
              progress,
            })),
          );
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(String(err)).toContain('NaN');
      app.log.error({ err, roomId: 'xh4mebt3', gameId }, 'recording a coop run failed');
    }
    await app.close();
    return lines.join('');
  }

  async function team() {
    const a = await t.newUser();
    const b = await t.newUser();
    await grantPokemon(t.db, a.userId, [{ dex: 25 }]);
    await grantPokemon(t.db, b.userId, [{ dex: 1 }]);
    return [a, b] as const;
  }

  const save = async (c: TestClient) => (await c.get('/api/save')).json<SaveView>();

  it('reads the failed insert of each game once, whatever its retries', async () => {
    const [a, b] = await team();
    const log = [
      '{"level":30,"msg":"server listening"}',
      'not json',
      await failedLines([a, b], 'game-1'),
    ].join('\n');
    const parsed = parseFailedRecordings(log);
    expect(parsed.duplicates).toBe(2);
    expect(parsed.unreadable).toEqual([]);
    expect(parsed.games).toHaveLength(1);
    const game = parsed.games[0]!;
    expect(game).toMatchObject({ gameId: 'game-1', roomId: 'xh4mebt3' });
    expect(game.error).toContain('NaN');
    expect(game.players).toEqual([
      {
        userId: a.userId,
        pokemon: { dex: 25, shiny: true },
        level: 30,
        kills: 474,
        bosses: 2,
        coins: 243,
        ticketsX1: 2,
        ticketsX10: 0,
        shiniesCaught: [133],
        progress,
      },
      expect.objectContaining({ userId: b.userId, coins: 244, ticketsX10: 1, shiniesCaught: [] }),
    ]);

    // A line without the SQL (only the params): the columns in schema order.
    const entry = JSON.parse(log.split('\n').at(-2)!) as { err: { query?: string } };
    delete entry.err.query;
    const fallback = parseFailedRecordings(JSON.stringify(entry));
    expect(fallback.games[0]?.players).toEqual(game.players);

    const broken = parseFailedRecordings(
      '{"msg":"recording a coop run failed","gameId":"g","time":1,"err":{"params":[1,2,3]}}',
    );
    expect(broken.games).toEqual([]);
    expect(broken.unreadable).toHaveLength(1);
    expect(broken.unreadable[0]?.reason).toContain('columns');
  });

  it('prints what it would credit and writes nothing without --apply', async () => {
    const [a, b] = await team();
    const parsed = parseFailedRecordings(await failedLines([a, b], 'game-dry', 1));
    const before = await save(a);
    const results = await recreditGames(t.db.db, parsed.games, { apply: false, timeZone: TZ });
    expect(results[0]?.outcome.kind).toBe('credit');
    const text = formatResults(parsed, results, false);
    expect(text).toContain('would credit as run');
    expect(text).toMatch(/\(Pikachu ✨\): \+243 coins, \+2 tickets, \+0 ×10, 0 gems; level 30/);
    expect(text).toContain('progress: 380 type defeats, 1 chest, 1 rift win');
    expect(text).toContain('Would credit 1 game, 2 players: 487 coins, 4 tickets, 1 ×10 tickets');
    expect(text).toContain('Dry run: nothing was written');
    const [row] = await t.db.db
      .select()
      .from(runs)
      .where(eq(runs.id, recreditRunId('game-dry')));
    expect(row).toBeUndefined();
    expect((await save(a)).coins).toBe(before.coins);
  });

  it('credits through recordCoopRun with --apply, once', async () => {
    const [a, b] = await team();
    const [beforeA, beforeB] = [await save(a), await save(b)];
    const parsed = parseFailedRecordings(await failedLines([a, b], 'game-apply'));
    const game = parsed.games[0]!;
    const runId = recreditRunId('game-apply');

    const results = await recreditGames(t.db.db, parsed.games, { apply: true, timeZone: TZ });
    expect(results[0]?.outcome).toMatchObject({ kind: 'credit', runId });
    expect(formatResults(parsed, results, true)).toContain('Credited 1 game, 2 players');
    const [run] = await t.db.db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({
      mode: 'coop',
      status: 'finished',
      durationS: 0,
      endedAt: game.failedAt,
    });
    const rows = await t.db.db.select().from(runPlayers).where(eq(runPlayers.runId, runId));
    expect(rows.map((r) => [r.coins, r.gems]).sort()).toEqual([
      [243, 0],
      [244, 0],
    ]);
    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(and(eq(currencyLedger.userId, a.userId), eq(currencyLedger.refId, runId)));
    expect(ledger.map((l) => [l.currency, l.delta, l.reason]).sort()).toEqual([
      ['coins', 243, 'run_reward'],
      ['tickets_x1', 2, 'run_reward'],
    ]);
    const afterA = await save(a);
    expect(afterA.coins).toBeGreaterThanOrEqual(beforeA.coins + 243);
    expect(afterA.shiny[133]).toBeDefined();
    expect(afterA.stats).toMatchObject({ runs: 1, groupRuns: 1, totalKills: 474, riftWins: 1 });
    expect(afterA.arenasWon.fire).toBeDefined();
    // Missions count for today, not the run's day.
    expect(afterA.missions.daily.period).toBe(periodsAt(new Date(), TZ).daily);
    expect((await save(b)).tickets.x10).toBeGreaterThanOrEqual(beforeB.tickets.x10 + 1);

    // A second time (the same lines, or only some of them): already done.
    const again = parseFailedRecordings(await failedLines([a, b], 'game-apply', 1));
    const second = await recreditGames(t.db.db, again.games, { apply: true, timeZone: TZ });
    expect(second[0]?.outcome).toMatchObject({ kind: 'already', runId });
    expect(formatResults(again, second, true)).toContain('skipped, re-credited before');
    expect((await save(a)).coins).toBe(afterA.coins);
  });

  it('skips a game a retry credited after all, and leaves out deleted players', async () => {
    const [a, b] = await team();
    const game: FailedGame = parseFailedRecordings(await failedLines([a, b], 'game-retried', 1))
      .games[0]!;
    await t.db.db.insert(runs).values({
      mode: 'coop',
      status: 'finished',
      teamKey: [a.userId, b.userId].sort().join(','),
      endedAt: new Date(game.failedAt.getTime() + 6000),
      durationS: 900,
    });
    const [retried] = await recreditGames(t.db.db, [game], { apply: true, timeZone: TZ });
    expect(retried?.outcome).toMatchObject({
      kind: 'already',
      reason: 'a co-op run of this team ended near the failure',
    });

    const gone = '00000000-0000-4000-8000-000000000000';
    const partial: FailedGame = {
      ...game,
      gameId: 'game-partial',
      players: [game.players[0]!, { ...game.players[1]!, userId: gone }],
    };
    const [result] = await recreditGames(t.db.db, [partial], { apply: true, timeZone: TZ });
    expect(result?.outcome).toMatchObject({ kind: 'credit', missing: [gone] });
    const rows = await t.db.db
      .select()
      .from(runPlayers)
      .where(eq(runPlayers.runId, recreditRunId('game-partial')));
    expect(rows.map((r) => r.userId)).toEqual([a.userId]);
    expect(
      formatResults({ games: [partial], unreadable: [], duplicates: 0 }, [result!], true),
    ).toContain(`left out: user ${gone} has no save`);
  });
});
