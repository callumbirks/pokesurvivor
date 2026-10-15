import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currencyLedger } from '../db/schema.js';
import { InsufficientFundsError } from '../economy/ledger.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';
import { withLockedSave } from './service.js';

describe('saves', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      economy: {
        startingCoins: 500,
        upgrades: {
          hp: { maxLevel: 2, baseCost: 100, growth: 2 },
          big: { maxLevel: 1, baseCost: 10_000, growth: 1 },
        },
      },
    });
  });
  afterAll(() => t.close());

  it('returns a fresh save', async () => {
    const c = await t.newUser();
    const res = await c.get('/api/save');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: 3,
      coins: 500,
      tickets: { x1: 0, x10: 0 },
      partner: { dex: null, shiny: false },
      owned: {},
      profile: { favourites: [], title: null },
      settings: { quality: 'auto', musicVolume: 0.55 },
      stats: { runs: 0, bestTimeS: 0 },
    });
  });

  it('sets the partner only to an owned Pokémon (and shiny only if the shiny is owned)', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }, { dex: 4, shiny: true }]);

    const notOwned = await c.put('/api/save/partner', { dex: 1 });
    expect(notOwned.statusCode).toBe(409);
    expect(notOwned.json()).toMatchObject({ error: { code: 'pokemon_not_owned' } });
    expect((await c.put('/api/save/partner', { dex: 25, shiny: true })).statusCode).toBe(409);

    const ok = await c.put('/api/save/partner', { dex: 4, shiny: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ partner: { dex: 4, shiny: true } });
  });

  it('updates favourites and title with ownership and unlock checks', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }, { dex: 7 }]);
    await withLockedSave(t.db.db, c.userId, (save) => {
      save.data.achievements['runs-50'] = Date.now();
    });

    const tooMany = await c.patch('/api/save/profile', {
      favourites: [1, 2, 3, 4].map((dex) => ({ dex, shiny: false })),
    });
    expect(tooMany.statusCode).toBe(400);
    const notOwned = await c.patch('/api/save/profile', {
      favourites: [{ dex: 150, shiny: false }],
    });
    expect(notOwned.statusCode).toBe(409);
    const dupes = await c.patch('/api/save/profile', {
      favourites: [
        { dex: 25, shiny: false },
        { dex: 25, shiny: false },
      ],
    });
    expect(dupes.json()).toMatchObject({ error: { code: 'duplicate_favourite' } });
    const unknown = await c.patch('/api/save/profile', { title: 'champion' });
    expect(unknown.json()).toMatchObject({ error: { code: 'unknown_title' } });
    // own-10 exists but gives no title; survive-20 gives one but isn't unlocked.
    const noTitle = await c.patch('/api/save/profile', { title: 'own-10' });
    expect(noTitle.json()).toMatchObject({ error: { code: 'unknown_title' } });
    const locked = await c.patch('/api/save/profile', { title: 'survive-20' });
    expect(locked.json()).toMatchObject({ error: { code: 'title_locked' } });

    const ok = await c.patch('/api/save/profile', {
      favourites: [
        { dex: 7, shiny: false },
        { dex: 25, shiny: false },
      ],
      title: 'runs-50',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      profile: {
        favourites: [
          { dex: 7, shiny: false },
          { dex: 25, shiny: false },
        ],
        title: 'runs-50',
      },
    });
    // Partial update: only the title changes.
    const cleared = await c.patch('/api/save/profile', { title: null });
    expect(cleared.json()).toMatchObject({
      profile: { favourites: [{ dex: 7 }, { dex: 25 }], title: null },
    });
  });

  it('merges settings and validates them', async () => {
    const c = await t.newUser();
    const ok = await c.patch('/api/save/settings', { quality: 'low', musicVolume: 0.2 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      settings: { quality: 'low', musicVolume: 0.2, sfxVolume: 0.7, damageNumbers: true },
    });
    expect((await c.patch('/api/save/settings', { musicVolume: 3 })).statusCode).toBe(400);
    expect((await c.patch('/api/save/settings', { quality: 'ultra' })).statusCode).toBe(400);
  });

  it('ignores attempts to write balances or the collection directly', async () => {
    const c = await t.newUser();
    await c.patch('/api/save/settings', { coins: 999_999, owned: { 150: {} } });
    await c.patch('/api/save/profile', { coins: 999_999 });
    const save = (await c.get('/api/save')).json<{ coins: number; owned: object }>();
    expect(save.coins).toBe(500);
    expect(save.owned).toEqual({});
    expect((await c.put('/api/save/coins', { coins: 1 })).statusCode).toBe(404);
  });

  it('buys upgrades with coins at the configured cost, up to the max level', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);

    const notOwned = await c.post('/api/save/upgrades', { dex: 1, upgradeId: 'hp' });
    expect(notOwned.json()).toMatchObject({ error: { code: 'pokemon_not_owned' } });
    const unknown = await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'toString' });
    expect(unknown.json()).toMatchObject({ error: { code: 'unknown_upgrade' } });

    // Costs 100 then 200 (base 100, growth ×2).
    const first = await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'hp' });
    expect(first.json()).toMatchObject({ coins: 400, upgrades: { 25: { hp: 1 } } });
    const second = await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'hp' });
    expect(second.json()).toMatchObject({ coins: 200, upgrades: { 25: { hp: 2 } } });
    const maxed = await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'hp' });
    expect(maxed.statusCode).toBe(409);
    expect(maxed.json()).toMatchObject({ error: { code: 'upgrade_maxed' } });

    const poor = await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'big' });
    expect(poor.statusCode).toBe(409);
    expect(poor.json()).toMatchObject({ error: { code: 'insufficient_funds' } });

    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, c.userId))
      .orderBy(currencyLedger.id);
    expect(ledger.map((l) => [l.reason, l.delta, l.balanceAfter, l.refId])).toEqual([
      ['starting_grant', 500, 500, null],
      ['upgrade_purchase', -100, 400, '25:hp:1'],
      ['upgrade_purchase', -200, 200, '25:hp:2'],
    ]);
    const { upgrades } = (await c.get('/api/upgrades')).json<{ upgrades: object }>();
    expect(upgrades).toHaveProperty('hp');
  });

  it('serialises concurrent purchases so coins never go negative', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 1 }, { dex: 2 }, { dex: 3 }, { dex: 4 }]);
    // 500 coins buys four or five 100-coin upgrades; fire six at once.
    const results = await Promise.all(
      [1, 2, 3, 4, 1, 2].map((dex) => c.post('/api/save/upgrades', { dex, upgradeId: 'hp' })),
    );
    const save = (await c.get('/api/save')).json<{ coins: number }>();
    const spent = results.filter((r) => r.statusCode === 200).length;
    expect(save.coins).toBeGreaterThanOrEqual(0);
    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, c.userId));
    expect(ledger.reduce((sum, l) => sum + l.delta, 0)).toBe(save.coins);
    expect(spent).toBeGreaterThan(0);
  });

  it('rolls back everything when a locked-save change throws', async () => {
    const c = await t.newUser();
    await expect(
      withLockedSave(t.db.db, c.userId, (save) => {
        save.wallet.credit('tickets_x1', 5, 'admin_adjustment');
        save.data.stats.runs = 99;
        save.wallet.debit('coins', 10_000, 'upgrade_purchase');
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    const save = (await c.get('/api/save')).json<{ tickets: { x1: number }; stats: object }>();
    expect(save.tickets.x1).toBe(0);
    expect(save.stats).toMatchObject({ runs: 0 });
  });
});
