// Balance records (R11): stored next to the run, validated and flagged, never changing what a
// run is credited with. No balance numbers are asserted.
import type { BalanceRecord, RunSummary } from '@pokesurvivor/protocol';
import { createSim } from '@pokesurvivor/sim';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData } from '../data.js';
import { runBalance, runs } from '../db/schema.js';
import { testRunCaps } from '../test/caps.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';
import { balanceFlags, parseBalance, type BalanceContext } from './balance.js';
import type { RunStats } from './caps.js';
import { recordCoopRun } from './service.js';

/** A real run's summary from the sim (bots standing still, kept up), for `dex`. */
function simRun(ids: string[], dex = 25, seconds = 130): Map<string, RunSummary> {
  const sim = createSim({
    seed: 11,
    players: ids.map((id) => ({ id, dex })),
    debug: { invulnerable: true },
  });
  while (sim.state.time < seconds) {
    for (const c of sim.state.pendingChoices.slice())
      if (c.kind === 'level-up')
        sim.submitIntent(c.playerId, {
          type: 'pickCard',
          choiceId: c.id,
          cardId: c.options[0]!.id,
        });
      else if (c.kind === 'item')
        sim.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.held });
      else
        sim.submitIntent(c.playerId, {
          type: 'pickBond',
          choiceId: c.id,
          moves: c.loose.slice(0, c.mode === 'add' ? 1 : 2),
        });
    // Level-ups now and then, so there are cards in the record.
    if (sim.state.tick % 300 === 0) {
      sim.state.team.level++;
      sim.state.pendingLevels++;
    }
    sim.step();
  }
  return new Map(ids.map((id) => [id, sim.runSummaryFor(id)]));
}

const clone = <T>(v: T): T => structuredClone(v);
const contextOf = (run: RunSummary): BalanceContext => ({
  durationS: run.durationS,
  level: run.level,
  kills: run.kills,
  dex: run.balance!.setup.dex,
});

describe('balance records: validation and flags', () => {
  const run = simRun(['a']).get('a')!;
  const rec = run.balance!;

  it('accepts what the sim produces, with no flags', () => {
    expect(parseBalance(rec)).toEqual({ ok: true, record: rec });
    expect(parseBalance(undefined)).toBeNull();
    expect(balanceFlags(rec, contextOf(run))).toEqual([]);
    expect(rec.picks.length).toBeGreaterThan(0);
  });

  it('accepts wild legendaries and downs by one, and records from before them', () => {
    const withLegends = clone(rec);
    withLegends.wildLegends = [
      { t: 1900, dex: 150, maxHp: 1e6, defeatedAt: 1950, dealt: 1e6, top: true },
      { t: 2000, dex: 249, maxHp: 1e6, defeatedAt: null, dealt: 0 },
    ];
    withLegends.downs.push({
      t: 2010,
      by: { kind: 'zone', dex: 249, tier: 'wildLegend' },
      taken10s: 900,
      revivedAt: null,
    });
    expect(parseBalance(withLegends)).toEqual({ ok: true, record: withLegends });
    const before = clone(rec);
    delete before.wildLegends;
    expect(parseBalance(before)).toEqual({ ok: true, record: before });
  });

  it('refuses malformed or oversized records', () => {
    expect(parseBalance({ v: 1 })).toMatchObject({ ok: false });
    expect(parseBalance('nope')).toMatchObject({ ok: false });
    const extra = { ...clone(rec), surprise: 1 };
    expect(parseBalance(extra)).toMatchObject({ ok: false });
    const bad = clone(rec);
    bad.timeline[0]!.atk = Number.NaN;
    expect(parseBalance(bad)).toMatchObject({ ok: false });
    const huge = clone(rec);
    huge.items = Array.from({ length: 5000 }, (_, t) => ({ t, id: 'x'.repeat(60) }));
    const tooLarge = parseBalance(huge);
    expect(tooLarge?.ok).toBe(false);
    expect(tooLarge?.ok === false && tooLarge.reason).toMatch(/large/);
  });

  it('flags implausible values', () => {
    const ctx = contextOf(run);
    const flags = (edit: (r: BalanceRecord) => void, over: Partial<BalanceContext> = {}) => {
      const r = clone(rec);
      edit(r);
      return balanceFlags(r, { ...ctx, ...over });
    };
    const d = getServerData();
    const power = d.levelUp.statCards.find(
      (c) => c.effect.type === 'stat' && c.effect.stat === 'attackMul',
    )!;
    const cap = power.effect.type === 'stat' ? power.effect.cap! : 0;

    expect(flags((r) => (r.timeline[0]!.atkCard = cap * 2))).toEqual(
      expect.arrayContaining(['atk-card-above-cap', 'atk-card-vs-picks']),
    );
    // Within the cap, but more than the Power picks taken could build.
    expect(flags((r) => (r.timeline.at(-1)!.atkCard = 3))).toContain('atk-card-vs-picks');
    expect(flags((r) => (r.timeline[0]!.def = d.tuning.defense.max + 1))).toEqual([
      'defense-above-max',
    ]);
    expect(flags((r) => (r.timeline[0]!.crit = 1.5))).toEqual(['crit-above-max']);
    expect(flags((r) => r.timeline.push(...r.timeline))).toContain('timeline-vs-duration');
    expect(flags((r) => (r.end.t = 3600))).toEqual(
      expect.arrayContaining(['timeline-vs-duration', 'end-vs-summary']),
    );
    expect(
      flags((r) => {
        for (let i = 0; i < 50; i++)
          r.picks.push({ t: 1, lv: 2, card: `stat:${power.id}`, value: 1.01, declined: [] });
      }),
    ).toContain('picks-above-levels');
    expect(flags(() => {}, { dex: 1 })).toEqual(['setup-dex']);
    expect(flags((r) => (r.setup.prestige = 3), { save: { prestige: 1, upgrades: {} } })).toEqual([
      'setup-above-save',
    ]);
    expect(flags(() => {}, { capped: true })).toEqual(['claim-capped']);
  });
});

describe('balance records: storage', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ economy: { runCaps: testRunCaps } });
  });
  afterAll(() => t.close());

  async function soloRun() {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    const res = await c.post('/api/runs/start', { pokemon: { dex: 25, shiny: false } });
    const runId = res.json<{ runId: string }>().runId;
    // Started long enough ago for the run's duration (nothing is capped).
    await t.db.db
      .update(runs)
      .set({ startedAt: sql`now() - make_interval(secs => 300)` })
      .where(eq(runs.id, runId));
    return { c, runId };
  }

  const stored = (runId: string) =>
    t.db.db.select().from(runBalance).where(eq(runBalance.runId, runId));

  it('stores a solo run’s record from its checkpoints and final report', async () => {
    const { c, runId } = await soloRun();
    const early = simRun(['a'], 25, 70).get('a')!;
    const res = await c.post('/api/runs/checkpoint', { runId, ...early });
    expect(res.statusCode, res.body).toBe(200);
    // What's credited stays the same shape: no balance in it.
    expect(res.json<{ stats: RunStats }>().stats).not.toHaveProperty('balance');
    let [row] = await stored(runId);
    expect(row).toMatchObject({ source: 'client', version: 1, flags: [] });
    expect(row!.record).toEqual(early.balance);

    const final = simRun(['a']).get('a')!;
    const done = await c.post('/api/runs', { runId, ...final });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ stats: RunStats }>().stats).not.toHaveProperty('balance');
    [row] = await stored(runId);
    expect(row!.record).toEqual(final.balance);
    expect(row!.flags).toEqual([]);
  });

  it('drops a malformed solo record and credits the run all the same', async () => {
    const run = simRun(['a']).get('a')!;
    const plain: RunSummary = { ...run };
    delete plain.balance;
    const credited: unknown[] = [];
    for (const balance of [undefined, { v: 1, nonsense: true }, 'x'.repeat(200_000)]) {
      const { c, runId } = await soloRun();
      const res = await c.post('/api/runs', { runId, ...plain, balance });
      expect(res.statusCode, res.body).toBe(200);
      credited.push(res.json<{ stats: RunStats }>().stats);
      expect(await stored(runId)).toEqual([]);
    }
    expect(credited[1]).toEqual(credited[0]);
    expect(credited[2]).toEqual(credited[0]);
  });

  it('flags an implausible solo record without changing the credit', async () => {
    const run = simRun(['a']).get('a')!;
    const { c, runId } = await soloRun();
    const tampered = clone(run);
    tampered.balance!.timeline[0]!.atkCard = 99;
    const res = await c.post('/api/runs', { runId, ...tampered });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await stored(runId);
    expect(row!.flags).toEqual(expect.arrayContaining(['atk-card-above-cap']));

    const clean = await soloRun();
    const ok = await clean.c.post('/api/runs', { runId: clean.runId, ...run });
    expect(ok.json<{ stats: RunStats }>().stats).toEqual(res.json<{ stats: RunStats }>().stats);
  });

  it('stores co-op records from the server’s sim', async () => {
    const [a, b] = [await t.newUser(), await t.newUser()];
    const results = simRun([a.userId, b.userId]);
    const now = new Date();
    const { runId } = await recordCoopRun(
      t.db.db,
      {
        startedAt: new Date(now.getTime() - 200_000),
        endedAt: now,
        durationS: results.get(a.userId)!.durationS,
        players: [a, b].map((u) => {
          const stats: Partial<RunSummary> = { ...results.get(u.userId)! };
          delete stats.durationS;
          return {
            userId: u.userId,
            pokemon: { dex: 25, shiny: false },
            ...(stats as Omit<RunSummary, 'durationS'>),
          };
        }),
      },
      { timeZone: 'UTC' },
    );
    const rows = await stored(runId);
    expect(rows.map((r) => [r.userId, r.source, r.flags]).sort()).toEqual(
      [
        [a.userId, 'server', []],
        [b.userId, 'server', []],
      ].sort(),
    );
    expect(rows.every((r) => r.record.setup.players === 2)).toBe(true);
  });
});
