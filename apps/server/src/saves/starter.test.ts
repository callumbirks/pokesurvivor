import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData } from '../data.js';
import { currencyLedger, saves } from '../db/schema.js';
import { upgradeCost, upgradesFromData } from '../economy/config.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';
import { migrateSaveData, newSaveData } from './schema.js';
import type { SaveView } from './service.js';
import { withLockedSave } from './service.js';

describe('upgrades from packages/data', () => {
  it('uses upgrades.json with the legacy cost formula', () => {
    const upgrades = upgradesFromData();
    expect(Object.keys(upgrades)).toEqual(getServerData().upgrades.map((u) => u.id));
    expect(upgrades['max-hp']).toEqual({ maxLevel: 10, baseCost: 60, growth: 1.35 });
    // round(60 · 1.35^l / 10) · 10
    expect([0, 1, 2, 9].map((l) => upgradeCost(upgrades['max-hp']!, l))).toEqual([
      60, 80, 110, 890,
    ]);
  });
});

describe('save data migration', () => {
  it('renames v1 upgrade ids and adds the v2 fields', () => {
    const { personality, moveBindings, moveBans, ...v2Only } = newSaveData();
    void personality;
    void moveBindings;
    void moveBans;
    const v1 = {
      ...v2Only,
      upgrades: { 25: { hp: 2, atk: 1, regen: 3, moves: 1 } },
      missions: {
        daily: { period: null, missions: [] },
        weekly: { period: null, missions: [] },
      },
    };
    const migrated = migrateSaveData(1, v1);
    expect(migrated.upgrades).toEqual({
      25: { 'max-hp': 2, attack: 1, regen: 3, 'extra-move': 1 },
    });
    expect(migrated).toMatchObject({
      personality: null,
      moveBindings: {},
      moveBans: {},
      missions: { daily: { period: null, rerolled: false, missions: [] } },
    });
  });
});

describe('starter and moves', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  interface StarterResponse {
    achievements: { id: string }[];
    save: SaveView;
  }

  it('grants a starter as partner, with the personality test result', async () => {
    const c = await t.newUser();
    const test = getServerData().starters.personalityTest;
    const res = await c.post('/api/save/starter', { dex: 4, answers: test.map(() => 0) });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<StarterResponse>();
    expect(body.save).toMatchObject({
      starter: 4,
      partner: { dex: 4, shiny: false },
      owned: { 4: { from: 'starter' } },
      personality: { trait: expect.any(String) as string },
      // The own-1 achievement pays 100 coins, as in legacy.
      coins: 600,
      tickets: { x1: 0, x10: 0 },
    });
    expect(body.achievements.map((a) => a.id)).toEqual(['own-1']);
    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, c.userId));
    expect(ledger.map((l) => [l.reason, l.delta, l.refId])).toEqual([
      ['starting_grant', 500, null],
      ['achievement_reward', 100, 'own-1'],
    ]);
  });

  it('lets you pick any starter directly, once, while you own nothing', async () => {
    const c = await t.newUser();
    expect((await t.client().post('/api/save/starter', { dex: 1 })).statusCode).toBe(401);
    const notStarter = await c.post('/api/save/starter', { dex: 150 });
    expect(notStarter.json()).toMatchObject({ error: { code: 'not_a_starter' } });
    const unknown = await c.post('/api/save/starter', { dex: 5000 });
    expect(unknown.statusCode).toBe(400);
    const badAnswers = await c.post('/api/save/starter', { dex: 1, answers: [0] });
    expect(badAnswers.json()).toMatchObject({ error: { code: 'invalid_answers' } });

    const ok = await c.post('/api/save/starter', { dex: 79 });
    expect(ok.json<StarterResponse>().save).toMatchObject({ starter: 79, personality: null });
    const again = await c.post('/api/save/starter', { dex: 1 });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'starter_already_chosen' } });

    const owner = await t.newUser();
    await grantPokemon(t.db, owner.userId, [{ dex: 25 }]);
    expect((await owner.post('/api/save/starter', { dex: 1 })).statusCode).toBe(409);
  });

  it('grants one starter when two requests race', async () => {
    const c = await t.newUser();
    const both = await Promise.all([
      c.post('/api/save/starter', { dex: 1 }),
      c.post('/api/save/starter', { dex: 4 }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const save = (await c.get('/api/save')).json<SaveView>();
    expect(Object.keys(save.owned)).toHaveLength(1);
  });

  it('binds moves to slots and bans moves up to the ban upgrade level', async () => {
    const c = await t.newUser();
    await c.post('/api/save/starter', { dex: 4 }); // Charmander: ember, fire + normal pool
    const fireMove = getServerData()
      .movePoolOf(getServerData().pokemonByDex.get(4)!)
      .find((m) => m.type === 'fire' && m.id !== 'ember')!.id;

    const bound = await c.put('/api/save/moves/4', { bindings: ['ember', null, 'tackle', null] });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json()).toMatchObject({ moveBindings: { 4: ['ember', null, 'tackle', null] } });
    for (const bindings of [
      ['water-gun', null, null, null], // not in Charmander's pool
      ['ember', 'ember', null, null],
      ['ember', null, null],
    ])
      expect((await c.put('/api/save/moves/4', { bindings })).statusCode).toBe(400);
    expect(
      (await c.put('/api/save/moves/7', { bindings: [null, null, null, null] })).json(),
    ).toMatchObject({ error: { code: 'pokemon_not_owned' } });

    const noBans = await c.put('/api/save/moves/4', { bans: [fireMove] });
    expect(noBans.json()).toMatchObject({ error: { code: 'too_many_bans' } });
    await withLockedSave(t.db.db, c.userId, (save) => {
      save.data.upgrades['4'] = { ban: 1 };
    });
    const startBan = await c.put('/api/save/moves/4', { bans: ['ember'] });
    expect(startBan.json()).toMatchObject({ error: { code: 'invalid_move' } });
    const banned = await c.put('/api/save/moves/4', { bans: [fireMove] });
    expect(banned.json()).toMatchObject({ moveBans: { 4: [fireMove] } });
    expect((await c.put('/api/save/moves/4', { bans: [fireMove, 'tackle'] })).statusCode).toBe(409);

    const cleared = await c.put('/api/save/moves/4', {
      bans: [],
      bindings: [null, null, null, null],
    });
    expect(cleared.json()).toMatchObject({ moveBans: {}, moveBindings: {} });
  });

  it('migrates a stored v1 save when it is read', async () => {
    const c = await t.newUser();
    const { personality, moveBindings, moveBans, ...v1 } = newSaveData();
    void personality;
    void moveBindings;
    void moveBans;
    await t.db.db
      .update(saves)
      .set({
        dataVersion: 1,
        data: {
          ...v1,
          owned: { 25: { at: 1, from: 'gacha' } },
          upgrades: { 25: { hp: 1 } },
          missions: {
            daily: { period: null, missions: [] },
            weekly: { period: null, missions: [] },
          },
        } as never,
      })
      .where(eq(saves.userId, c.userId));
    expect((await c.get('/api/save')).json()).toMatchObject({
      version: 2,
      upgrades: { 25: { 'max-hp': 1 } },
    });
    // Writing it back stores version 2.
    await c.patch('/api/save/settings', { muted: true });
    const [row] = await t.db.db.select().from(saves).where(eq(saves.userId, c.userId));
    expect(row?.dataVersion).toBe(2);
  });
});
