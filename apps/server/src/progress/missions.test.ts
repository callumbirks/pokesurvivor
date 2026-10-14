import { emptyRunProgress } from '@pokesurvivor/protocol';
import type { RunProgress } from '@pokesurvivor/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData } from '../data.js';
import { currencyLedger, runs } from '../db/schema.js';
import { testRunCaps } from '../test/caps.js';
import { expectedAchievements } from '../test/rewards.js';
import { recordCoopRun } from '../runs/service.js';
import type { MissionSet, MissionState } from '../saves/schema.js';
import type { SaveView } from '../saves/service.js';
import { withLockedSave } from '../saves/service.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';
import { periodsAt, rollMissions } from './missions.js';

const TZ = 'Europe/Madrid';

describe('mission periods and rolls', () => {
  it('names days and ISO weeks in the time zone', () => {
    // 23:30 UTC on 31 Dec 2025 is already 1 Jan 2026 in Madrid, a Thursday: ISO week 1.
    expect(periodsAt(new Date('2025-12-31T23:30:00Z'), TZ)).toEqual({
      daily: '2026-01-01',
      weekly: '2026-W01',
    });
    expect(periodsAt(new Date('2025-12-31T22:30:00Z'), 'UTC')).toEqual({
      daily: '2025-12-31',
      weekly: '2026-W01',
    });
    // 1 Jan 2027 is a Friday: still the last week (53) of 2026.
    expect(periodsAt(new Date('2027-01-01T12:00:00Z'), TZ).weekly).toBe('2026-W53');
    expect(periodsAt(new Date('2026-10-13T12:00:00Z'), TZ)).toEqual({
      daily: '2026-10-13',
      weekly: '2026-W42',
    });
  });

  it('rolls stable, distinct missions per user and period', () => {
    const { missions } = getServerData();
    const a = rollMissions('user-a', 'daily', '2026-10-13');
    expect(a).toEqual(rollMissions('user-a', 'daily', '2026-10-13'));
    expect(a).toHaveLength(missions.dailyCount);
    expect(new Set(a.map((m) => m.id)).size).toBe(a.length);
    for (const m of a) {
      const def = getServerData().missionById.get(m.id)!;
      expect(def.goals).toContain(m.goal);
      expect(m.param === null).toBe(def.param === undefined);
      expect(m).toMatchObject({ progress: 0, claimed: false });
    }
    expect(rollMissions('user-a', 'weekly', '2026-W42')).toHaveLength(missions.weeklyCount);
    // Different users or days get different sets (with overwhelming probability).
    const others = ['user-b', 'user-c', 'user-d'].map((u) =>
      rollMissions(u, 'daily', '2026-10-13'),
    );
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(a))).toBe(true);
  });
});

const mission = (id: string, goal: number, param: string | null = null): MissionState => ({
  id,
  goal,
  param,
  progress: 0,
  claimed: false,
});

describe('missions', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ economy: { runCaps: testRunCaps } });
  });
  afterAll(() => t.close());

  /** A player with Charmander and the given missions for the current period. */
  async function player(daily: MissionState[], weekly: MissionState[] = []) {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 4 }]);
    const periods = periodsAt(new Date(), TZ);
    await withLockedSave(t.db.db, c.userId, (save) => {
      save.data.missions = {
        daily: { period: periods.daily, rerolled: false, missions: daily },
        weekly: { period: periods.weekly, rerolled: false, missions: weekly },
      };
    });
    return c;
  }

  async function soloRun(
    c: TestClient,
    durationS: number,
    over: { kills?: number; bosses?: number; coins?: number; level?: number },
    progress: Partial<RunProgress> = {},
  ) {
    const start = await c.post('/api/runs/start', { pokemon: { dex: 4, shiny: false } });
    const { runId } = start.json<{ runId: string }>();
    await t.db.db
      .update(runs)
      .set({ startedAt: sql`now() - make_interval(secs => ${durationS + 5})` })
      .where(eq(runs.id, runId));
    const res = await c.post('/api/runs', {
      runId,
      durationS,
      level: 1,
      kills: 0,
      bosses: 0,
      coins: 0,
      ticketsX1: 0,
      ticketsX10: 0,
      shiniesCaught: [],
      ...over,
      progress: { ...emptyRunProgress(), ...progress },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ save: SaveView; achievements: { id: string }[] }>();
  }

  it('rolls the current missions on first read and keeps them', async () => {
    const c = await t.newUser();
    const first = await c.get('/api/missions');
    expect(first.statusCode).toBe(200);
    const sets = first.json<{ daily: MissionSet; weekly: MissionSet }>();
    const periods = periodsAt(new Date(), TZ);
    expect(sets.daily).toMatchObject({ period: periods.daily, rerolled: false });
    expect(sets.daily.missions).toEqual(rollMissions(c.userId, 'daily', periods.daily));
    expect(sets.weekly.missions).toEqual(rollMissions(c.userId, 'weekly', periods.weekly));
    expect((await c.get('/api/missions')).json()).toEqual(sets);
    expect((await t.client().get('/api/missions')).statusCode).toBe(401);
  });

  it('replaces missions from an older period', async () => {
    const c = await t.newUser();
    await withLockedSave(t.db.db, c.userId, (save) => {
      save.data.missions.daily = {
        period: '2020-01-01',
        rerolled: true,
        missions: [{ ...mission('defeat', 300), progress: 300 }],
      };
    });
    const { daily } = (await c.get('/api/missions')).json<{ daily: MissionSet }>();
    expect(daily.period).toBe(periodsAt(new Date(), TZ).daily);
    expect(daily.rerolled).toBe(false);
  });

  it('advances missions from run results, filters included', async () => {
    const c = await player(
      [
        mission('defeat', 300),
        mission('defeat-type', 30, 'water'),
        mission('survive-type', 3, 'fire'),
        mission('collect-coins', 300),
      ],
      [mission('weekly-rift-win', 2), mission('weekly-evolve-move', 3), mission('survive', 9)],
    );
    const { save } = await soloRun(
      c,
      240,
      { kills: 200, coins: 120 },
      {
        defeatsByType: { water: 12, grass: 50 },
        riftWins: ['fire'],
        movesEvolved: ['ember'],
      },
    );
    const progress = (set: MissionSet) => set.missions.map((m) => m.progress);
    // Charmander is fire: 4 minutes counts for "survive with a fire-type".
    expect(progress(save.missions.daily)).toEqual([200, 12, 3, 120]);
    expect(progress(save.missions.weekly)).toEqual([1, 1, 4]);
    expect(save.itemsFound).toEqual({});
    expect(save.movesEvolved).toHaveProperty('ember');
    expect(save.arenasWon).toHaveProperty('fire');
    expect(save.stats).toMatchObject({ riftWins: 1, evolutions: 1 });

    const second = await soloRun(
      c,
      120,
      { kills: 150, coins: 200 },
      { defeatsByType: { water: 30 } },
    );
    // Progress stops at the goal; "max" missions keep the best run.
    expect(progress(second.save.missions.daily)).toEqual([300, 30, 3, 300]);
    expect(progress(second.save.missions.weekly)).toEqual([1, 1, 4]);
  });

  it('claims finished missions through the ledger, once', async () => {
    const c = await player(
      [mission('defeat', 300), mission('open-chest', 1), mission('find-item', 1)],
      [mission('weekly-daily-missions', 8)],
    );
    await soloRun(c, 300, { kills: 400 }, { chestsOpened: 1 });

    const notDone = await c.post('/api/missions/daily/2/claim');
    expect(notDone.json()).toMatchObject({ error: { code: 'mission_not_done' } });
    expect((await c.post('/api/missions/daily/9/claim')).statusCode).toBe(404);
    expect((await c.post('/api/missions/monthly/0/claim')).statusCode).toBe(400);

    const before = (await c.get('/api/save')).json<SaveView>();
    const claimed = await c.post('/api/missions/daily/0/claim');
    expect(claimed.statusCode, claimed.body).toBe(200);
    const body = claimed.json<{ save: SaveView; missions: { weekly: MissionSet } }>();
    const reward = getServerData().missionById.get('defeat')!.reward;
    expect(body.save.coins).toBe(before.coins + (reward.coins ?? 0));
    expect(body.save.tickets.x1).toBe(before.tickets.x1 + (reward.tickets ?? 0));
    expect(body.save.stats.missionsDone).toBe(1);
    expect(body.save.missions.daily.missions[0]?.claimed).toBe(true);
    // Completing a daily advances "complete N daily missions".
    expect(body.missions.weekly.missions[0]?.progress).toBe(1);

    const again = await c.post('/api/missions/daily/0/claim');
    expect(again.json()).toMatchObject({ error: { code: 'mission_already_claimed' } });
    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, c.userId));
    expect(ledger.filter((l) => l.reason === 'mission_reward')).toHaveLength(
      Object.keys(reward).length,
    );
  });

  it('rerolls one unclaimed daily mission a day', async () => {
    const c = await player([
      mission('defeat', 300),
      mission('open-chest', 1),
      mission('survive', 5),
    ]);
    const res = await c.post('/api/missions/daily/1/reroll');
    expect(res.statusCode, res.body).toBe(200);
    const { daily } = res.json<{ daily: MissionSet }>();
    expect(daily.rerolled).toBe(true);
    const ids = daily.missions.map((m) => m.id);
    expect(ids[0]).toBe('defeat');
    expect(ids[2]).toBe('survive');
    expect(['defeat', 'open-chest', 'survive']).not.toContain(ids[1]);
    expect(new Set(ids).size).toBe(3);
    const twice = await c.post('/api/missions/daily/0/reroll');
    expect(twice.json()).toMatchObject({ error: { code: 'mission_reroll_used' } });
  });

  it('counts coop runs and unlocks achievements from save stats', async () => {
    const c = await player([mission('defeat-boss', 2)], [mission('weekly-defeat', 4000)]);
    await recordCoopRun(
      t.db.db,
      {
        startedAt: new Date(Date.now() - 600_000),
        endedAt: new Date(),
        durationS: 600,
        players: [
          {
            userId: c.userId,
            pokemon: { dex: 4, shiny: false },
            level: 20,
            kills: 1200,
            bosses: 3,
            coins: 300,
            ticketsX1: 0,
            ticketsX10: 0,
            shiniesCaught: [],
            progress: {
              ...emptyRunProgress(),
              riftWins: ['water'],
              legendariesDefeated: [144],
              rescued: [16],
              itemsEquipped: ['leftovers'],
            },
          },
        ],
      },
      { timeZone: TZ },
    );
    const save = (await c.get('/api/save')).json<SaveView>();
    expect(save.missions.daily.missions[0]?.progress).toBe(2);
    expect(save.missions.weekly.missions[0]?.progress).toBe(1200);
    expect(save.owned[16]).toMatchObject({ from: 'rescue' });
    expect(save.legendsBeaten).toHaveProperty('144');
    expect(save.itemsFound).toHaveProperty('leftovers');
    const expected = expectedAchievements(
      {
        'pokemon-owned': 2,
        'best-time-minutes': 10,
        'best-level': 20,
        runs: 1,
        'total-defeated': 1200,
        'bosses-defeated': 3,
        'rift-wins': 1,
        'arenas-won': 1,
        'legendaries-defeated': 1,
        'distinct-items-found': 1,
        'group-runs': 1,
      },
      [144],
    );
    expect(Object.keys(save.achievements).sort()).toEqual(expected.map((a) => a.id).sort());
    // A saved unlock permits its title independently of the run's achievement thresholds.
    await withLockedSave(t.db.db, c.userId, (save) => {
      save.data.achievements['rift-1'] = 1;
    });
    const titled = await c.patch('/api/save/profile', { title: 'rift-1' });
    expect(titled.json()).toMatchObject({ profile: { title: 'rift-1' } });
  });
});
