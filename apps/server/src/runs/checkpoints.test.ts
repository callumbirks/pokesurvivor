// Solo run checkpoints (`POST /api/runs/checkpoint`), the timeout credit from the last
// checkpoint, and the rule that a run is credited at most once however it ends.
import { emptyRunProgress } from '@pokesurvivor/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { currencyLedger, runPlayers, runs } from '../db/schema.js';
import { getSave } from '../saves/service.js';
import { testRunCaps } from '../test/caps.js';
import { expectedAchievements, rewardTotals } from '../test/rewards.js';
import { createTestApp, createTestDatabase, grantPokemon, TestClient } from '../test/harness.js';
import type { TestApp, TestDatabase } from '../test/harness.js';
import type { RunStats } from './caps.js';
import { creditTimedOutRuns } from './service.js';

const caps = testRunCaps;
const TZ = { timeZone: 'Europe/Madrid' };
const TIMEOUT_MS = 600_000;

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

async function player(t: TestApp) {
  const c = await t.newUser();
  await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
  return c;
}

async function start(db: Db, c: TestClient, seconds = 0): Promise<string> {
  const res = await c.post('/api/runs/start', { pokemon: { dex: 25, shiny: false } });
  expect(res.statusCode, res.body).toBe(201);
  const { runId } = res.json<{ runId: string }>();
  // Pretend the run was started `seconds` ago, so the caps allow that much play.
  if (seconds) await backdate(db, runId, 'startedAt', seconds);
  return runId;
}

/** Moves a run's start or last checkpoint `s` seconds into the past. */
async function backdate(db: Db, runId: string, column: 'startedAt' | 'checkpointAt', s: number) {
  await db.db
    .update(runs)
    .set({ [column]: sql`now() - make_interval(secs => ${s})` })
    .where(eq(runs.id, runId));
}

/** Coins credited for this run (achievements it unlocked pay coins too; those aren't counted). */
async function runCoins(db: Db, runId: string): Promise<number> {
  const rows = await runRewards(db, runId);
  return rows.filter((r) => r.currency === 'coins').reduce((sum, r) => sum + r.delta, 0);
}

async function runRewards(db: Db, runId: string) {
  return db.db
    .select({ currency: currencyLedger.currency, delta: currencyLedger.delta })
    .from(currencyLedger)
    .where(and(eq(currencyLedger.refId, runId), eq(currencyLedger.reason, 'run_reward')));
}

describe('solo run checkpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ economy: { runCaps: testRunCaps } });
  });
  afterAll(() => t.close());

  it('stores the latest capped checkpoint and credits nothing', async () => {
    const c = await player(t);
    const runId = await start(t.db, c, 125);
    const before = await getSave(t.db.db, c.userId);

    const first = await c.post('/api/runs/checkpoint', {
      runId,
      ...summary({ durationS: 60, coins: 40, kills: 30 }),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      runId,
      capped: false,
      stats: { durationS: 60, coins: 40 },
    });

    // Over the allowances for two minutes: clamped exactly like a final report.
    const claim = summary({ durationS: 120, coins: 1_000_000, ticketsX1: 99, kills: 60 });
    const second = await c.post('/api/runs/checkpoint', { runId, ...claim });
    expect(second.json()).toMatchObject({
      capped: true,
      stats: {
        durationS: 120,
        coins: caps.coinsFlat + 2 * caps.coinsPerMinute,
        ticketsX1: Math.floor(caps.ticketsX1Flat + 2 * caps.ticketsX1PerMinute),
      },
    });

    const [row] = await t.db.db.select().from(runPlayers).where(eq(runPlayers.runId, runId));
    expect(row?.checkpoint).toEqual(second.json<{ stats: RunStats }>().stats);
    expect(row?.claimed).toEqual(claim);
    expect(row?.coins).toBe(0);
    const [run] = await t.db.db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ status: 'started', timedOut: false });
    expect(run?.checkpointAt).toBeInstanceOf(Date);

    const after = await getSave(t.db.db, c.userId);
    expect(after.coins).toBe(before.coins);
    expect(after.stats.runs).toBe(before.stats.runs);
    expect(await runRewards(t.db, runId)).toEqual([]);
  });

  it('validates checkpoints and only takes them from the run’s player, while it is open', async () => {
    const c = await player(t);
    const other = await player(t);
    const runId = await start(t.db, c);
    expect(
      (await t.client().post('/api/runs/checkpoint', { runId, ...summary() })).statusCode,
    ).toBe(401);
    const bad = await c.post('/api/runs/checkpoint', { runId, ...summary({ kills: -1 }) });
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_request' } });
    const theirs = await other.post('/api/runs/checkpoint', { runId, ...summary() });
    expect(theirs.json()).toMatchObject({ error: { code: 'run_not_found' } });

    expect((await c.post('/api/runs', { runId, ...summary() })).statusCode).toBe(200);
    const late = await c.post('/api/runs/checkpoint', { runId, ...summary() });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: { code: 'run_already_finished' } });
  });

  it('credits the last checkpoint once the timeout passes, and closes the run', async () => {
    const c = await player(t);
    const runId = await start(t.db, c, 200);
    const fresh = await start(t.db, c, 200);
    const noCheckpoint = await start(t.db, c, 3600);
    const before = await getSave(t.db.db, c.userId);
    const cp = summary({ durationS: 180, level: 9, kills: 120, coins: 70, ticketsX1: 1 });
    await c.post('/api/runs/checkpoint', { runId, ...cp });
    await c.post('/api/runs/checkpoint', { runId: fresh, ...summary({ durationS: 30, coins: 5 }) });
    await backdate(t.db, runId, 'checkpointAt', TIMEOUT_MS / 1000 + 5);
    await backdate(t.db, fresh, 'checkpointAt', TIMEOUT_MS / 1000 - 30);

    expect(await creditTimedOutRuns(t.db.db, TIMEOUT_MS, TZ)).toEqual([runId]);
    // Idempotent: nothing more on a second pass.
    expect(await creditTimedOutRuns(t.db.db, TIMEOUT_MS, TZ)).toEqual([]);

    const after = await getSave(t.db.db, c.userId);
    expect(await runCoins(t.db, runId)).toBe(70);
    const rewards = rewardTotals(
      expectedAchievements({
        'pokemon-owned': 1,
        'best-time-minutes': 3,
        'best-level': 9,
        'total-defeated': 120,
        runs: 1,
      }),
    );
    expect(after.tickets.x1 - before.tickets.x1).toBe(cp.ticketsX1 + rewards.tickets);
    expect(after.stats.runs - before.stats.runs).toBe(1);
    expect(after.stats.bestTimeS).toBeGreaterThanOrEqual(180);

    const rows = await t.db.db.select().from(runs).where(eq(runs.teamKey, c.userId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const timedOut = byId.get(runId)!;
    expect(timedOut).toMatchObject({ status: 'finished', timedOut: true, durationS: 180 });
    // It ended when it was last heard of (leaderboards and missions use that day).
    expect(timedOut.endedAt).toEqual(timedOut.checkpointAt);
    expect(byId.get(fresh)).toMatchObject({ status: 'started', timedOut: false });
    expect(byId.get(noCheckpoint)).toMatchObject({ status: 'started', timedOut: false });
    const [credited] = await t.db.db.select().from(runPlayers).where(eq(runPlayers.runId, runId));
    expect(credited).toMatchObject({ coins: 70, kills: 120, level: 9, ticketsX1: 1 });
  });

  it('refuses a final report and a resume after a timeout credit (no double credit)', async () => {
    const c = await player(t);
    const runId = await start(t.db, c, 400);
    const before = await getSave(t.db.db, c.userId);
    await c.post('/api/runs/checkpoint', { runId, ...summary({ durationS: 120, coins: 50 }) });
    await backdate(t.db, runId, 'checkpointAt', TIMEOUT_MS / 1000 + 1);
    expect(await creditTimedOutRuns(t.db.db, TIMEOUT_MS, TZ)).toEqual([runId]);

    // The tab comes back: resuming (its first checkpoint) and reporting are both refused.
    for (const url of ['/api/runs/checkpoint', '/api/runs']) {
      const res = await c.post(url, { runId, ...summary({ durationS: 300, coins: 120 }) });
      expect(res.statusCode).toBe(409);
      // With what was credited, so the client can show it.
      expect(res.json()).toMatchObject({
        error: { code: 'run_credited_by_timeout', credited: { durationS: 120, coins: 50 } },
      });
    }
    const after = await getSave(t.db.db, c.userId);
    expect(await runCoins(t.db, runId)).toBe(50);
    expect(after.stats.runs - before.stats.runs).toBe(1);
    expect(await runRewards(t.db, runId)).toEqual([{ currency: 'coins', delta: 50 }]);
  });

  it('does not credit a timed-out checkpoint after the final report', async () => {
    const c = await player(t);
    const runId = await start(t.db, c, 400);
    const before = await getSave(t.db.db, c.userId);
    await c.post('/api/runs/checkpoint', { runId, ...summary({ durationS: 120, coins: 50 }) });
    expect(
      (await c.post('/api/runs', { runId, ...summary({ durationS: 300, coins: 90 }) })).statusCode,
    ).toBe(200);
    await backdate(t.db, runId, 'checkpointAt', TIMEOUT_MS / 1000 + 1);
    expect(await creditTimedOutRuns(t.db.db, TIMEOUT_MS, TZ)).toEqual([]);
    const after = await getSave(t.db.db, c.userId);
    expect(await runCoins(t.db, runId)).toBe(90);
    expect(after.stats.runs - before.stats.runs).toBe(1);
  });

  it('credits a run once when the sweep and the final report race', async () => {
    for (let i = 0; i < 5; i++) {
      const c = await player(t);
      const runId = await start(t.db, c, 400);
      const before = await getSave(t.db.db, c.userId);
      await c.post('/api/runs/checkpoint', { runId, ...summary({ durationS: 120, coins: 50 }) });
      await backdate(t.db, runId, 'checkpointAt', TIMEOUT_MS / 1000 + 1);
      const [swept, report] = await Promise.all([
        creditTimedOutRuns(t.db.db, TIMEOUT_MS, TZ),
        c.post('/api/runs', { runId, ...summary({ durationS: 300, coins: 90 }) }),
      ]);
      const after = await getSave(t.db.db, c.userId);
      expect(after.stats.runs - before.stats.runs).toBe(1);
      if (report.statusCode === 200) {
        expect(swept).not.toContain(runId);
        expect(await runCoins(t.db, runId)).toBe(90);
      } else {
        expect(report.json()).toMatchObject({ error: { code: 'run_credited_by_timeout' } });
        expect(swept).toContain(runId);
        expect(await runCoins(t.db, runId)).toBe(50);
      }
      expect(await runRewards(t.db, runId)).toHaveLength(1);
    }
  });
});

describe('solo run timeout across a server restart', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database.drop());

  it('credits runs that timed out while the server was down, from the database', async () => {
    const env = { RUN_CHECKPOINT_TIMEOUT_S: String(TIMEOUT_MS / 1000) };
    const first = await createTestApp({ database, env, economy: { runCaps: testRunCaps } });
    const c = await player(first);
    const runId = await start(database.db, c, 300);
    const before = await getSave(database.db.db, c.userId);
    await c.post('/api/runs/checkpoint', { runId, ...summary({ durationS: 240, coins: 66 }) });
    await first.close();

    // The server is down past the timeout; nothing is in memory any more.
    await backdate(database.db, runId, 'checkpointAt', TIMEOUT_MS / 1000 + 60);
    const second = await createTestApp({ database, env, economy: { runCaps: testRunCaps } });
    try {
      // The new instance sweeps once at start.
      await second.app.runSweeper?.sweep();
      const after = await getSave(database.db.db, c.userId);
      expect(await runCoins(database.db, runId)).toBe(66);
      expect(after.stats.runs - before.stats.runs).toBe(1);

      // The player's tab comes back to the new instance: the run is closed.
      const again = new TestClient(second.app);
      again.cookie = c.cookie;
      const res = await again.post('/api/runs', { runId, ...summary({ durationS: 260 }) });
      expect(res.json()).toMatchObject({ error: { code: 'run_credited_by_timeout' } });
    } finally {
      await second.close();
    }
  });
});
