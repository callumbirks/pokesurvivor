// The admin run export: admin only, the filters, the flagged toggle, paging. Records are seeded
// straight into the tables from one real sim record; no balance numbers are asserted.
import type { BalanceRecord } from '@pokesurvivor/protocol';
import { createSim } from '@pokesurvivor/sim';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configVersions, runBalance, runPlayers, runs, users } from '../db/schema.js';
import { createTestApp } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';
import { exportFilters, exportJson } from './export.js';

interface Entry {
  run: { id: string; mode: string; players: number; durationS: number; configVersion: number };
  player: { username: string; dex: number; credited: { level: number } };
  flags: string[];
  balance: BalanceRecord;
}
interface ExportFile {
  filters: unknown;
  entries: Entry[];
  configVersions: Record<string, { overrides: unknown }>;
}

function simRecord(): BalanceRecord {
  const sim = createSim({
    seed: 3,
    players: [{ id: 'a', dex: 25 }],
    debug: { invulnerable: true },
  });
  while (sim.state.time < 65) sim.step();
  return sim.runSummaryFor('a').balance!;
}

describe('admin run export', () => {
  let t: TestApp;
  let admin: TestClient;
  let alice: TestClient & { username: string; userId: string };
  let bob: TestClient & { username: string; userId: string };
  let tuned: number;
  const record = simRecord();

  async function seed(o: {
    mode: 'solo' | 'coop';
    players: { userId: string; dex: number; flags?: string[]; reason?: 'all-down' | null }[];
    durationS: number;
    endedAt: string;
    configVersion?: number;
  }) {
    const [run] = await t.db.db
      .insert(runs)
      .values({
        mode: o.mode,
        status: 'finished',
        teamKey: o.players.map((p) => p.userId).join(','),
        startedAt: new Date(new Date(o.endedAt).getTime() - o.durationS * 1000),
        endedAt: new Date(o.endedAt),
        durationS: o.durationS,
        configVersion: o.configVersion ?? 0,
      })
      .returning({ id: runs.id });
    for (const p of o.players) {
      await t.db.db
        .insert(runPlayers)
        .values({ runId: run!.id, userId: p.userId, pokemonDex: p.dex, level: 7 });
      const rec = structuredClone(record);
      rec.setup.dex = p.dex;
      rec.end.reason = p.reason === undefined ? 'all-down' : p.reason;
      await t.db.db.insert(runBalance).values({
        runId: run!.id,
        userId: p.userId,
        version: 1,
        source: o.mode === 'solo' ? 'client' : 'server',
        record: rec,
        flags: p.flags ?? [],
      });
    }
    return run!.id;
  }

  const download = async (query = '') => {
    const res = await admin.get(`/api/admin/runs/export${query}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*\.json"/);
    return res.json<ExportFile>();
  };
  const count = async (query = '') =>
    (await admin.get(`/api/admin/runs/count${query}`)).json<{ count: number; flagged: number }>();

  let runA: string;
  let runB: string;
  let runC: string;
  let runD: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.newUser();
    const adminId = (admin as TestClient & { userId: string }).userId;
    await t.db.db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
    alice = await t.newUser();
    bob = await t.newUser();
    const [v] = await t.db.db
      .insert(configVersions)
      .values({ overrides: { tuning: { momentum: { perStack: 0.03 } } }, note: 'test' })
      .returning({ id: configVersions.id });
    tuned = v!.id;
    runA = await seed({
      mode: 'solo',
      players: [{ userId: alice.userId, dex: 25 }],
      durationS: 300,
      endedAt: '2026-10-01T12:00:00Z',
    });
    runB = await seed({
      mode: 'solo',
      players: [{ userId: alice.userId, dex: 4, flags: ['atk-card-above-cap'] }],
      durationS: 1500,
      endedAt: '2026-10-05T12:00:00Z',
    });
    runC = await seed({
      mode: 'coop',
      players: [
        { userId: alice.userId, dex: 25, reason: null },
        { userId: bob.userId, dex: 7, reason: null },
      ],
      durationS: 1300,
      endedAt: '2026-10-10T12:00:00Z',
      configVersion: tuned,
    });
    runD = await seed({
      mode: 'solo',
      players: [{ userId: bob.userId, dex: 7 }],
      durationS: 60,
      endedAt: '2026-10-12T12:00:00Z',
      configVersion: tuned,
    });
  });
  afterAll(() => t.close());

  it('is for admins only', async () => {
    for (const url of ['/api/admin/runs/export', '/api/admin/runs/count']) {
      expect((await t.client().get(url)).statusCode).toBe(401);
      expect((await alice.get(url)).statusCode).toBe(404);
    }
  });

  it('exports every unflagged record with its run, player and config', async () => {
    const file = await download();
    // Oldest first; the flagged one left out.
    expect(file.entries.map((e) => e.run.id)).toEqual([runA, runC, runC, runD]);
    const c = file.entries.filter((e) => e.run.id === runC);
    expect(c.map((e) => e.player.username).sort()).toEqual([alice.username, bob.username].sort());
    expect(c[0]!.run).toMatchObject({ mode: 'coop', players: 2, configVersion: tuned });
    expect(file.entries[0]!.balance.timeline.length).toBeGreaterThan(0);
    expect(file.entries[0]!.player.credited.level).toBe(7);
    expect(Object.keys(file.configVersions).sort()).toEqual(['0', String(tuned)].sort());
    expect(file.configVersions[String(tuned)]!.overrides).toEqual({
      tuning: { momentum: { perStack: 0.03 } },
    });
    expect(await count()).toEqual({ count: 4, flagged: 1 });
  });

  it('filters', async () => {
    const ids = async (q: string) => {
      const file = await download(q);
      const n = await count(q);
      expect(n.count).toBe(file.entries.length);
      return file.entries.map((e) => `${e.run.id}:${e.player.username}`).sort();
    };
    const key = (run: string, u: { username: string }) => `${run}:${u.username}`;
    expect(await ids('?includeFlagged=true')).toHaveLength(5);
    expect(await ids('?includeFlagged=true&dex=4')).toEqual([key(runB, alice)]);
    expect(await ids(`?username=${alice.username.toUpperCase()}`)).toEqual(
      [key(runA, alice), key(runC, alice)].sort(),
    );
    expect(await ids('?mode=coop')).toHaveLength(2);
    expect(await ids('?mode=solo&players=1')).toEqual([key(runA, alice), key(runD, bob)].sort());
    expect(await ids('?players=2')).toHaveLength(2);
    expect(await ids('?minDurationS=1200&includeFlagged=true')).toEqual(
      [key(runB, alice), key(runC, alice), key(runC, bob)].sort(),
    );
    expect(await ids('?maxDurationS=300')).toEqual([key(runA, alice), key(runD, bob)].sort());
    expect(await ids(`?configVersion=${tuned}`)).toHaveLength(3);
    expect(await ids('?configVersion=0')).toEqual([key(runA, alice)]);
    expect(await ids('?from=2026-10-04&to=2026-10-11')).toHaveLength(2);
    expect(await ids('?outcome=none')).toHaveLength(2);
    expect(await ids('?outcome=all-down')).toEqual([key(runA, alice), key(runD, bob)].sort());
    expect((await admin.get('/api/admin/runs/export?mode=pvp')).statusCode).toBe(400);
  });

  it('reads page by page into one valid file', async () => {
    let text = '';
    for await (const chunk of exportJson(
      t.db.db,
      exportFilters.parse({ includeFlagged: 'true' }),
      2,
    ))
      text += chunk;
    const file = JSON.parse(text) as ExportFile;
    expect(file.entries.map((e) => e.run.id)).toEqual([runA, runB, runC, runC, runD]);
    expect(new Set(file.entries.map((e) => `${e.run.id}:${e.player.username}`)).size).toBe(5);
  });
});
