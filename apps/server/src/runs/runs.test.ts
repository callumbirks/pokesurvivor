import { emptyRunProgress } from '@pokesurvivor/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currencyLedger, runPlayers, runs } from '../db/schema.js';
import { DEFAULT_ECONOMY } from '../economy/config.js';
import { getServerData } from '../data.js';
import { testRunCaps } from '../test/caps.js';
import { expectedAchievements, rewardTotals } from '../test/rewards.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';
import type { SaveView } from '../saves/service.js';
import { capRunStats } from './caps.js';
import type { RunStats } from './caps.js';
import { recordCoopRun } from './service.js';

const caps = testRunCaps;

interface FinishResponse {
  runId: string;
  capped: boolean;
  stats: RunStats;
  save: SaveView;
}

const summary = (over: Partial<RunStats> = {}): RunStats => ({
  durationS: 0,
  level: 1,
  kills: 0,
  bosses: 0,
  coins: 0,
  ticketsX1: 0,
  ticketsX10: 0,
  shiniesCaught: [],
  progress: emptyRunProgress(),
  ...over,
});

const TZ = { timeZone: 'Europe/Madrid' };

describe('capRunStats', () => {
  it('keeps a plausible run as is', () => {
    const claim = summary({ durationS: 600, level: 30, kills: 900, bosses: 3, coins: 800 });
    expect(capRunStats(claim, caps, 605)).toEqual({ stats: claim, capped: false });
    const withProgress = summary({
      durationS: 600,
      kills: 900,
      progress: {
        defeatsByType: { fire: 100, water: 900 },
        chestsOpened: 2,
        itemsEquipped: ['leftovers'],
        movesEvolved: ['tackle'],
        riftWins: ['fire'],
        legendariesDefeated: [146],
        rescued: [16],
      },
    });
    expect(capRunStats(withProgress, caps, 605)).toEqual({ stats: withProgress, capped: false });
  });

  it('caps the duration at the wall-clock time since start and the max duration', () => {
    expect(capRunStats(summary({ durationS: 600 }), caps, 120).stats.durationS).toBe(120);
    expect(capRunStats(summary({ durationS: 99_999 }), caps, 99_999).stats.durationS).toBe(
      caps.maxDurationS,
    );
  });

  it('caps rewards per minute survived', () => {
    const { stats, capped } = capRunStats(
      summary({
        durationS: 120,
        level: 999,
        kills: 1e6,
        bosses: 50,
        coins: 1e6,
        ticketsX1: 50,
        ticketsX10: 9,
        shiniesCaught: getServerData()
          .pokedex.filter((p) => getServerData().hasShinySprite(p.dex))
          .map((p) => p.dex),
      }),
      caps,
      120,
    );
    expect(capped).toBe(true);
    expect(stats).toEqual({
      durationS: 120,
      level: caps.maxLevel,
      kills: 2 * caps.killsPerMinute,
      bosses: 2 * caps.bossesPerMinute,
      coins: caps.coinsFlat + 2 * caps.coinsPerMinute,
      ticketsX1: Math.floor(caps.ticketsX1Flat + 2 * caps.ticketsX1PerMinute),
      ticketsX10: Math.floor(caps.ticketsX10Flat + 2 * caps.ticketsX10PerMinute),
      shiniesCaught: getServerData()
        .pokedex.filter((p) => getServerData().hasShinySprite(p.dex))
        .map((p) => p.dex)
        .slice(
          0,
          Math.min(caps.shiniesMax, Math.floor(caps.shiniesFlat + 2 * caps.shiniesPerMinute)),
        ),
      progress: emptyRunProgress(),
    });
  });

  it('caps run progress per minute and drops what cannot happen', () => {
    const { stats, capped } = capRunStats(
      summary({
        durationS: 120,
        kills: 50,
        progress: {
          defeatsByType: { fire: 9999 },
          chestsOpened: 99,
          itemsEquipped: Array(20).fill('leftovers') as string[],
          movesEvolved: Array(20).fill('tackle') as string[],
          riftWins: ['fire', 'water', 'grass', 'ice'],
          // Pidgey is not legendary; Mewtwo is.
          legendariesDefeated: [16, 150, 150],
          // Mewtwo can't be a lost Pokémon; Pidgey and Rattata can.
          rescued: [150, 16, 19, 16, 20, 21],
        },
      }),
      caps,
      120,
    );
    expect(capped).toBe(true);
    const limit = (flat: number, perMinute: number) => Math.floor(flat + perMinute * 2);
    expect(stats.progress).toEqual({
      defeatsByType: { fire: 50 },
      chestsOpened: limit(caps.chestsFlat, caps.chestsPerMinute),
      itemsEquipped: Array(limit(caps.itemsFlat, caps.itemsPerMinute)).fill('leftovers'),
      movesEvolved: Array(limit(caps.evolutionsFlat, caps.evolutionsPerMinute)).fill('tackle'),
      riftWins: ['fire', 'water', 'grass', 'ice'].slice(
        0,
        limit(caps.riftWinsFlat, caps.riftWinsPerMinute),
      ),
      legendariesDefeated: limit(caps.riftWinsFlat, caps.riftWinsPerMinute) > 0 ? [150] : [],
      rescued: [16, 19, 20, 21].slice(
        0,
        Math.min(caps.rescuesMax, limit(caps.rescuesFlat, caps.rescuesPerMinute)),
      ),
    });
  });

  it('deduplicates shinies', () => {
    const { stats } = capRunStats(summary({ durationS: 3600, shiniesCaught: [5, 5] }), caps, 3600);
    expect(stats.shiniesCaught).toEqual([5]);
  });
});

describe('runs', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ economy: { runCaps: testRunCaps } });
  });
  afterAll(() => t.close());

  async function player(dexes = [25]) {
    const c = await t.newUser();
    await grantPokemon(
      t.db,
      c.userId,
      dexes.map((dex) => ({ dex })),
    );
    return c;
  }

  async function start(c: TestClient, dex = 25, shiny = false): Promise<string> {
    const res = await c.post('/api/runs/start', { pokemon: { dex, shiny } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ runId: string }>().runId;
  }

  /** Pretends the run was started `seconds` ago. */
  async function backdate(runId: string, seconds: number) {
    await t.db.db
      .update(runs)
      .set({ startedAt: sql`now() - make_interval(secs => ${seconds})` })
      .where(eq(runs.id, runId));
  }

  it('needs a login and an owned Pokémon to start', async () => {
    expect(
      (await t.client().post('/api/runs/start', { pokemon: { dex: 25, shiny: false } })).statusCode,
    ).toBe(401);
    const c = await player();
    const res = await c.post('/api/runs/start', { pokemon: { dex: 150, shiny: false } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'pokemon_not_owned' } });
  });

  it('credits a plausible solo run through the ledger and updates stats', async () => {
    const c = await player();
    const runId = await start(c);
    await backdate(runId, 600);
    const res = await c.post('/api/runs', {
      runId,
      ...summary({
        durationS: 590,
        level: 25,
        kills: 700,
        bosses: 2,
        coins: 450,
        ticketsX1: 3,
        ticketsX10: 1,
        shiniesCaught: [133],
      }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<FinishResponse>();
    const rewards = rewardTotals(
      expectedAchievements({
        'pokemon-owned': 2,
        'shinies-owned': 1,
        'best-time-minutes': Math.floor(590 / 60),
        'best-level': 25,
        runs: 1,
        'total-defeated': 700,
        'bosses-defeated': 2,
      }),
    );
    expect(body).toMatchObject({ runId, capped: false, stats: { durationS: 590, coins: 450 } });
    expect(body.save).toMatchObject({
      coins: DEFAULT_ECONOMY.startingCoins + 450 + rewards.coins,
      tickets: { x1: 3 + rewards.tickets, x10: 1 + rewards.tickets10 },
      owned: { 133: { from: 'wild' } },
      shiny: { 133: { from: 'wild' } },
      stats: {
        runs: 1,
        bestTimeS: 590,
        bestLevel: 25,
        totalKills: 700,
        bossesTotal: 2,
        shinies: 1,
      },
    });

    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.refId, runId));
    expect(ledger.map((l) => [l.currency, l.delta, l.reason]).sort()).toEqual([
      ['coins', 450, 'run_reward'],
      ['tickets_x1', 3, 'run_reward'],
      ['tickets_x10', 1, 'run_reward'],
    ]);
  });

  it('caps an implausible run and keeps the original claim', async () => {
    const c = await player();
    const runId = await start(c);
    await backdate(runId, 60);
    // Claims an hour and a fortune after one minute.
    const claim = summary({ durationS: 3600, coins: 1_000_000, ticketsX1: 500, ticketsX10: 50 });
    const res = await c.post('/api/runs', { runId, ...claim });
    const body = res.json<FinishResponse>();
    expect(body.capped).toBe(true);
    expect(body.stats.durationS).toBeGreaterThanOrEqual(60);
    expect(body.stats.durationS).toBeLessThan(70);
    expect(body.stats.coins).toBeLessThanOrEqual(caps.coinsFlat + (70 / 60) * caps.coinsPerMinute);
    const rewards = rewardTotals(
      expectedAchievements({
        'pokemon-owned': 1,
        'best-time-minutes': Math.floor(body.stats.durationS / 60),
        'best-level': 1,
        runs: 1,
      }),
    );
    expect(body.save.coins).toBe(DEFAULT_ECONOMY.startingCoins + body.stats.coins + rewards.coins);
    expect(body.save.tickets.x10).toBe(body.stats.ticketsX10 + rewards.tickets10);

    const [row] = await t.db.db.select().from(runPlayers).where(eq(runPlayers.runId, runId));
    expect(row?.claimed).toMatchObject({ durationS: 3600, coins: 1_000_000 });
    expect(row?.coins).toBe(body.stats.coins);
  });

  it('caps the duration to the time since the run started', async () => {
    const c = await player();
    const runId = await start(c);
    const res = await c.post('/api/runs', { runId, ...summary({ durationS: 1200, coins: 300 }) });
    expect(res.json()).toMatchObject({
      capped: true,
      stats: { durationS: 0, coins: caps.coinsFlat },
    });
  });

  it('accepts each run once, only from its player', async () => {
    const c = await player();
    const other = await player();
    const runId = await start(c);
    const body = { runId, ...summary({ coins: 10 }) };
    expect((await other.post('/api/runs', body)).statusCode).toBe(404);
    expect((await c.post('/api/runs', body)).statusCode).toBe(200);
    const again = await c.post('/api/runs', body);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'run_already_finished' } });
    // A concurrent double submit credits once.
    const runId2 = await start(c);
    const both = await Promise.all([
      c.post('/api/runs', { ...body, runId: runId2 }),
      c.post('/api/runs', { ...body, runId: runId2 }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const rewards = rewardTotals(
      expectedAchievements({ 'pokemon-owned': 1, 'best-level': 1, runs: 2 }),
    );
    expect((await c.get('/api/save')).json()).toMatchObject({
      coins: DEFAULT_ECONOMY.startingCoins + 20 + rewards.coins,
    });
  });

  it('validates the summary', async () => {
    const c = await player();
    const runId = await start(c);
    const progress = emptyRunProgress();
    for (const bad of [
      { coins: -5 },
      { kills: 1.5 },
      { shiniesCaught: [0] },
      { shiniesCaught: [5000] },
      { progress: { ...progress, defeatsByType: { plasma: 3 } } },
      { progress: { ...progress, itemsEquipped: ['excalibur'] } },
      { progress: { ...progress, movesEvolved: ['hyper-beam-9000'] } },
      { progress: { ...progress, riftWins: ['shadow'] } },
      { progress: { ...progress, rescued: [99999] } },
    ])
      expect((await c.post('/api/runs', { runId, ...summary(), ...bad })).statusCode).toBe(400);
    expect((await c.post('/api/runs', { ...summary(), runId: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('records coop runs reported by the game server for every player', async () => {
    const a = await player();
    const b = await player([1]);
    const startedAt = new Date(Date.now() - 900_000);
    const { runId, achievements } = await recordCoopRun(
      t.db.db,
      {
        startedAt,
        endedAt: new Date(),
        durationS: 900,
        players: [
          {
            ...summary({ level: 40, kills: 2000, coins: 700, ticketsX1: 2 }),
            userId: a.userId,
            pokemon: { dex: 25, shiny: false },
          },
          {
            ...summary({ level: 35, kills: 1500, coins: 600 }),
            userId: b.userId,
            pokemon: { dex: 1, shiny: false },
          },
        ],
      },
      TZ,
    );
    const expectedA = expectedAchievements({
      'pokemon-owned': 1,
      'best-time-minutes': 15,
      'best-level': 40,
      runs: 1,
      'total-defeated': 2000,
      'group-runs': 1,
    });
    const rewardsA = rewardTotals(expectedA);
    const expectedB = expectedAchievements({
      'pokemon-owned': 1,
      'best-time-minutes': 15,
      'best-level': 35,
      runs: 1,
      'total-defeated': 1500,
      'group-runs': 1,
    });
    const rewardsB = rewardTotals(expectedB);
    const saveA = (await a.get('/api/save')).json<SaveView>();
    expect(saveA).toMatchObject({
      coins: DEFAULT_ECONOMY.startingCoins + 700 + rewardsA.coins,
      tickets: { x1: 2 + rewardsA.tickets, x10: rewardsA.tickets10 },
      stats: { runs: 1, groupRuns: 1, bestGroupTimeS: 900, bestTimeS: 900, bestLevel: 40 },
    });
    expect(Object.keys(saveA.achievements).sort()).toEqual(expectedA.map((a) => a.id).sort());
    // Each player's unlocks come back with what they credited, for their results screen.
    const unlockedA = achievements.get(a.userId) ?? [];
    expect(unlockedA.map((u) => u.id).sort()).toEqual(expectedA.map((a) => a.id).sort());
    for (const expected of expectedA)
      expect(unlockedA.find((u) => u.id === expected.id)?.reward).toEqual(expected.reward);
    expect(
      achievements
        .get(b.userId)
        ?.map((u) => u.id)
        .sort(),
    ).toEqual(expectedB.map((a) => a.id).sort());
    expect((await b.get('/api/save')).json()).toMatchObject({
      coins: DEFAULT_ECONOMY.startingCoins + 600 + rewardsB.coins,
    });
    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.refId, runId));
    expect(ledger).toHaveLength(3);
  });
});

describe('leaderboard', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ economy: { runCaps: testRunCaps } });
  });
  afterAll(() => t.close());

  type Board = {
    entries: {
      rank: number;
      durationS: number;
      players: { username: string; pokemon: { dex: number } }[];
    }[];
    me: { rank: number; durationS: number } | null;
  };

  async function soloRun(c: { userId: string }, durationS: number, dex = 25, endedDaysAgo = 0) {
    const [run] = await t.db.db
      .insert(runs)
      .values({
        mode: 'solo',
        status: 'finished',
        teamKey: c.userId,
        durationS,
        endedAt: sql`now() - make_interval(days => ${endedDaysAgo})`,
      })
      .returning({ id: runs.id });
    await t.db.db
      .insert(runPlayers)
      .values({ runId: run!.id, userId: c.userId, pokemonDex: dex, level: 10, kills: 100 });
  }

  async function coopRun(players: { userId: string }[], durationS: number, dex = 25) {
    await recordCoopRun(
      t.db.db,
      {
        startedAt: new Date(Date.now() - durationS * 1000),
        endedAt: new Date(),
        durationS,
        players: players.map((p) => ({
          ...summary(),
          userId: p.userId,
          pokemon: { dex, shiny: false },
        })),
      },
      TZ,
    );
  }

  async function befriend(
    a: TestClient & { username: string },
    b: TestClient & { username: string },
  ) {
    await a.post('/api/friends/requests', { username: b.username });
    await b.post(`/api/friends/requests/${a.username}/accept`);
  }

  it('ranks solo players by their best time, with filters', async () => {
    const [alice, bob, carol, dave] = await Promise.all([1, 2, 3, 4].map(() => t.newUser()));
    await soloRun(alice!, 300);
    await soloRun(alice!, 900, 7); // her best, with Squirtle
    await soloRun(bob!, 600);
    await soloRun(carol!, 1200, 25, 10); // ten days ago
    await soloRun(dave!, 600);
    await befriend(alice!, bob!);

    const all = (await t.client().get('/api/leaderboard?mode=solo&period=all')).json<Board>();
    expect(all.entries.map((e) => [e.rank, e.durationS, e.players[0]?.username])).toEqual([
      [1, 1200, carol!.username],
      [2, 900, alice!.username],
      [3, 600, expect.any(String)],
      [3, 600, expect.any(String)],
    ]);
    expect(all.me).toBeNull();

    const daily = (await t.client().get('/api/leaderboard?period=daily')).json<Board>();
    expect(daily.entries.map((e) => e.durationS)).toEqual([900, 600, 600]);
    const weekly = (await t.client().get('/api/leaderboard?period=weekly')).json<Board>();
    expect(weekly.entries.map((e) => e.durationS)).not.toContain(1200);

    // Pikachu only: Alice's best Pikachu run is 300.
    const pikachu = (await t.client().get('/api/leaderboard?pokemon=25')).json<Board>();
    expect(pikachu.entries.map((e) => e.durationS)).toEqual([1200, 600, 600, 300]);

    const friends = (await alice!.get('/api/leaderboard?friends=true')).json<Board>();
    expect(friends.entries.map((e) => e.players[0]?.username)).toEqual([
      alice!.username,
      bob!.username,
    ]);
    expect(friends.me).toMatchObject({ rank: 1, durationS: 900 });

    const limited = (await bob!.get('/api/leaderboard?limit=1')).json<Board>();
    expect(limited.entries).toHaveLength(1);
    expect(limited.me).toMatchObject({ rank: 3, durationS: 600 });

    expect((await t.client().get('/api/leaderboard?friends=true')).statusCode).toBe(401);
    expect((await t.client().get('/api/leaderboard?period=yearly')).statusCode).toBe(400);
  });

  it('ranks groups with one entry per team', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => t.newUser()));
    await coopRun([a!, b!], 500);
    await coopRun([b!, a!], 800); // same team, better
    await coopRun([a!, c!], 650, 4);
    const board = (await a!.get('/api/leaderboard?mode=group')).json<Board>();
    expect(board.entries.map((e) => [e.durationS, e.players.length])).toEqual([
      [800, 2],
      [650, 2],
    ]);
    expect(board.me).toMatchObject({ rank: 1 });
    const charmander = (
      await t.client().get('/api/leaderboard?mode=group&pokemon=4')
    ).json<Board>();
    expect(charmander.entries.map((e) => e.durationS)).toEqual([650]);
    // Solo boards don't include coop runs.
    const solo = (await a!.get('/api/leaderboard?mode=solo')).json<Board>();
    expect(solo.me).toBeNull();
  });
});
