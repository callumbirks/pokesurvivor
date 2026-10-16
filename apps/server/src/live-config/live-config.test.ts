// Live tuning over HTTP: admin-only access, validation, versions and revert, the config solo runs
// are issued, "Export as patch", and stored overrides a newer build can't apply.
import { loadGameData, mergePatch, type TunableConfig } from '@pokesurvivor/data';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configVersions, runs, users } from '../db/schema.js';
import {
  createTestApp,
  createTestDatabase,
  grantPokemon,
  type TestApp,
  type TestClient,
  type TestDatabase,
} from '../test/harness.js';

const game = loadGameData();
const defaults: TunableConfig = { tuning: game.tuning, levelup: game.levelUp };
/** A valid change (the value itself doesn't matter). */
const cap = defaults.tuning.spawner.cap + 7;
const changed = () => mergePatch(defaults, { tuning: { spawner: { cap } } }) as TunableConfig;

async function makeAdmin(t: TestApp, userId: string): Promise<void> {
  await t.db.db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
}

interface View {
  version: number;
  createdBy: string | null;
  revertedFrom: number | null;
  overrides: Record<string, unknown>;
  skipped: { file: string; path: string; message: string }[];
  config: TunableConfig;
}
interface ErrorBody {
  error: { code: string; issues?: unknown; current?: number };
}

type Route = [method: 'GET' | 'PUT' | 'POST', url: string, payload?: object];

const ADMIN_ROUTES: Route[] = [
  ['GET', '/api/admin/config'],
  ['GET', '/api/admin/config/versions'],
  ['GET', '/api/admin/config/versions/0'],
  ['GET', '/api/admin/config/patch'],
  ['PUT', '/api/admin/config', { config: defaults, baseVersion: 0 }],
  ['POST', '/api/admin/config/revert', { version: 0, baseVersion: 0 }],
];

function call(c: TestClient, [method, url, payload]: Route) {
  return c.request({ method, url, ...(payload ? { payload } : {}) });
}

describe('live tuning', () => {
  let t: TestApp;
  let admin: Awaited<ReturnType<TestApp['newUser']>>;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await t.newUser();
    await makeAdmin(t, admin.userId);
  });
  afterAll(() => t.close());

  it('tells clients who is an admin', async () => {
    const me = await admin.get('/api/auth/me');
    expect(me.json<unknown>()).toMatchObject({ user: { isAdmin: true } });
    const player = await t.newUser();
    expect((await player.get('/api/auth/me')).json<unknown>()).toMatchObject({
      user: { isAdmin: false },
    });
  });

  it('answers 401 logged out and 404 to players on every admin endpoint', async () => {
    const player = await t.newUser();
    for (const route of ADMIN_ROUTES) {
      expect((await call(t.client(), route)).statusCode, route[1]).toBe(401);
      const res = await call(player, route);
      expect(res.statusCode, route[1]).toBe(404);
      expect(res.json<unknown>()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect((await admin.get('/api/admin/config')).statusCode).toBe(200);
  });

  it('serves the defaults as version 0 until something is published', async () => {
    const res = await t.client().get('/api/config');
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown>()).toEqual({ version: 0, ...defaults });
    const view = (await admin.get('/api/admin/config')).json<unknown>();
    expect(view).toMatchObject({ current: { version: 0, overrides: {}, skipped: [] }, defaults });
  });

  it('rejects invalid configs with clear messages, publishing nothing', async () => {
    const bad = mergePatch(defaults, {
      tuning: { spawner: { cap: -1 } },
      levelup: { weights: { surprise: 2 } },
    });
    const res = await admin.put('/api/admin/config', { config: bad, baseVersion: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error).toMatchObject({
      code: 'invalid_config',
      issues: expect.arrayContaining([
        expect.objectContaining({ file: 'tuning', path: 'spawner.cap' }),
        { file: 'levelup', path: 'weights.surprise', message: 'No such setting' },
      ]) as unknown,
    });
    const unchanged = await admin.put('/api/admin/config', { config: defaults, baseVersion: 0 });
    expect(unchanged.json<unknown>()).toMatchObject({ error: { code: 'config_unchanged' } });
    expect((await t.client().get('/api/config')).json<View>().version).toBe(0);
  });

  it('publishes a version on every save, keeps the history, and reverts', async () => {
    const saved = await admin.put('/api/admin/config', {
      config: changed(),
      note: 'more wild Pokémon',
      baseVersion: 0,
    });
    expect(saved.statusCode).toBe(200);
    const v1 = saved.json<View>();
    expect(v1).toMatchObject({
      version: 1,
      createdBy: admin.username,
      note: 'more wild Pokémon',
      overrides: { tuning: { spawner: { cap } } },
    });
    expect((await t.client().get('/api/config')).json<unknown>()).toMatchObject({
      version: 1,
      tuning: { spawner: { cap } },
    });

    // An edit based on an older version is refused (someone published meanwhile).
    const stale = await admin.put('/api/admin/config', { config: defaults, baseVersion: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ErrorBody>().error).toMatchObject({ code: 'config_changed', current: 1 });

    const toDefaults = await admin.post('/api/admin/config/revert', {
      version: 0,
      baseVersion: 1,
    });
    expect(toDefaults.json<unknown>()).toMatchObject({
      version: 2,
      revertedFrom: 0,
      overrides: {},
    });
    expect((await t.client().get('/api/config')).json<unknown>()).toEqual({
      version: 2,
      ...defaults,
    });

    const back = await admin.post('/api/admin/config/revert', { version: 1, baseVersion: 2 });
    expect(back.json<unknown>()).toMatchObject({
      version: 3,
      revertedFrom: 1,
      overrides: v1.overrides,
    });

    const { versions } = (await admin.get('/api/admin/config/versions')).json<{
      versions: { version: number }[];
    }>();
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1, 0]);
    expect(versions[2]).toMatchObject({ createdBy: admin.username, changes: 1 });
    const one = (await admin.get('/api/admin/config/versions/1')).json<unknown>();
    expect(one).toMatchObject({ version: 1, config: { tuning: { spawner: { cap } } } });
    expect((await admin.get('/api/admin/config/versions/99')).statusCode).toBe(404);
  });

  it('exports the overrides in effect as a patch', async () => {
    const res = await admin.get('/api/admin/config/patch');
    expect(res.json<unknown>()).toMatchObject({
      format: 'pokesurvivor-tuning-patch',
      version: 3,
      overrides: { tuning: { spawner: { cap } } },
    });
    // Merged into the defaults, the patch gives the published config.
    expect(mergePatch(defaults, res.json<{ overrides: unknown }>().overrides)).toEqual(
      (await admin.get('/api/admin/config')).json<{ current: View }>().current.config,
    );
  });

  it('issues every new solo run the published config and records its version', async () => {
    const player = await t.newUser();
    await grantPokemon(t.db, player.userId, [{ dex: 25 }]);
    const start = async () => {
      const res = await player.post('/api/runs/start', { pokemon: { dex: 25, shiny: false } });
      expect(res.statusCode).toBe(201);
      return res.json<{ runId: string; config: { version: number; tuning: unknown } }>();
    };
    const first = await start();
    expect(first.config).toMatchObject({ version: 3, tuning: { spawner: { cap } } });

    await admin.post('/api/admin/config/revert', { version: 0, baseVersion: 3 });
    const second = await start();
    expect(second.config).toEqual({ version: 4, ...defaults });

    const rows = await t.db.db
      .select({ id: runs.id, configVersion: runs.configVersion })
      .from(runs)
      .where(eq(runs.teamKey, player.userId));
    const byId = new Map(rows.map((r) => [r.id, r.configVersion]));
    expect(byId.get(first.runId)).toBe(3);
    expect(byId.get(second.runId)).toBe(4);
  });
});

describe('stored overrides a newer build cannot apply', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database.drop());

  it('skips them with a warning, keeps the rest, and starts anyway', async () => {
    // As if a deploy removed `spawner.oldSetting` and tightened `rift.chance` (at most 1).
    await database.db.db.insert(configVersions).values({
      overrides: {
        tuning: { spawner: { cap, oldSetting: 3 }, rift: { chance: 5 } },
        gacha: { cost: 1 },
      },
      note: 'from an older build',
    });
    const t = await createTestApp({ database });
    try {
      const admin = await t.newUser();
      await makeAdmin(t, admin.userId);
      const { current } = (await admin.get('/api/admin/config')).json<{ current: View }>();
      expect(current).toMatchObject({
        version: 1,
        overrides: { tuning: { spawner: { cap } } },
        config: { tuning: { spawner: { cap }, rift: { chance: defaults.tuning.rift.chance } } },
      });
      expect(current.skipped.map((s) => `${s.file}:${s.path}`)).toEqual(
        expect.arrayContaining(['tuning:spawner.oldSetting', 'tuning:rift.chance', 'gacha:']),
      );
      expect(current.skipped).toHaveLength(3);
      // Runs get the part that applies.
      expect((await t.client().get('/api/config')).json<unknown>()).toMatchObject({
        version: 1,
        tuning: { spawner: { cap } },
      });
      // Saving again publishes only what applies, which clears the warning.
      const res = await admin.put('/api/admin/config', { config: current.config, baseVersion: 1 });
      expect(res.json<unknown>()).toMatchObject({ version: 2, skipped: [] });
    } finally {
      await t.close();
    }
  });
});
