import { and, eq, gt, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData, pokemonOf } from '../data.js';
import { currencyLedger, pokemonPrestiges, saves } from '../db/schema.js';
import { loadLoadout, partnerOf } from '../game/loadout.js';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';
import { getSave } from './service.js';

interface SaveBody {
  coins: number;
  upgrades: Record<string, Record<string, number>>;
  prestige: Record<string, number>;
  moveBans: Record<string, string[]>;
  moveBindings: Record<string, (string | null)[]>;
}

describe('prestige', () => {
  let t: TestApp;
  const { maxStars } = getServerData().tuning.prestige;
  const pikachu = pokemonOf(25);
  const startingMove = getServerData().startingMoveOf(pikachu);
  const banned = getServerData()
    .movePoolOf(pikachu)
    .find((m) => m.id !== startingMove)!.id;

  beforeAll(async () => {
    t = await createTestApp({
      economy: {
        startingCoins: 10_000,
        upgrades: {
          hp: { maxLevel: 2, baseCost: 10, growth: 1 },
          ban: { maxLevel: 1, baseCost: 10, growth: 1 },
        },
      },
    });
  });
  afterAll(() => t.close());

  async function maxAll(c: TestClient, dex = 25): Promise<SaveBody> {
    for (const upgradeId of ['hp', 'hp', 'ban'])
      expect((await c.post('/api/save/upgrades', { dex, upgradeId })).statusCode).toBe(200);
    return (await c.get('/api/save')).json<SaveBody>();
  }

  it('starts every Pokémon at no stars, also in saves from before prestige', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    await c.put('/api/save/partner', { dex: 25 });
    expect((await c.get('/api/save')).json()).toMatchObject({ version: 4, prestige: {} });

    // A version 2 save has no `prestige` at all.
    await t.db.db
      .update(saves)
      .set({ dataVersion: 2, data: sql`${saves.data} - 'prestige'` })
      .where(eq(saves.userId, c.userId));
    const old = await getSave(t.db.db, c.userId);
    expect(old.prestige).toEqual({});
    expect(partnerOf(old)).toEqual({ dex: 25, shiny: false });
    expect((await loadLoadout(t.db.db, c.userId))?.config.prestige).toBe(0);
  });

  it('refuses Pokémon that are not owned or not fully upgraded', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    const notOwned = await c.post('/api/save/prestige', { dex: 1 });
    expect(notOwned.statusCode).toBe(409);
    expect(notOwned.json()).toMatchObject({ error: { code: 'pokemon_not_owned' } });
    expect((await c.post('/api/save/prestige', {})).statusCode).toBe(400);

    const none = await c.post('/api/save/prestige', { dex: 25 });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: { code: 'prestige_not_ready' } });
    await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'hp' });
    await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'hp' });
    // One upgrade (ban) still has a level to buy.
    const partly = await c.post('/api/save/prestige', { dex: 25 });
    expect(partly.json()).toMatchObject({ error: { code: 'prestige_not_ready' } });
    expect((await c.get('/api/save')).json()).toMatchObject({ prestige: {} });
  });

  it('resets every upgrade and banned move for a star, keeps the slots, and records it', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    const maxed = await maxAll(c);
    expect(
      (
        await c.put('/api/save/moves/25', {
          bans: [banned],
          bindings: [startingMove, null, null, null],
        })
      ).statusCode,
    ).toBe(200);

    const res = await c.post('/api/save/prestige', { dex: 25 });
    expect(res.statusCode).toBe(200);
    const save = res.json<SaveBody>();
    expect(save.prestige).toEqual({ 25: 1 });
    expect(save.upgrades[25]).toBeUndefined();
    expect(save.moveBans[25]).toBeUndefined();
    expect(save.moveBindings[25]).toEqual([startingMove, null, null, null]);
    expect(save.coins).toBe(maxed.coins); // free

    const [audit] = await t.db.db
      .select()
      .from(pokemonPrestiges)
      .where(eq(pokemonPrestiges.userId, c.userId));
    expect(audit).toMatchObject({
      dex: 25,
      stars: 1,
      reset: { upgrades: { hp: 2, ban: 1 }, moveBans: [banned] },
    });

    // The ledger marks the prestige, so coins spent since it can be summed (R6 gem resets).
    await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'hp' });
    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, c.userId))
      .orderBy(currencyLedger.id);
    const marker = ledger.find((l) => l.reason === 'prestige');
    expect(marker).toMatchObject({ delta: 0, balanceAfter: maxed.coins, refId: '25:prestige:1' });
    const since = await t.db.db
      .select({ spent: sql<number>`-sum(${currencyLedger.delta})::int` })
      .from(currencyLedger)
      .where(
        and(
          eq(currencyLedger.userId, c.userId),
          eq(currencyLedger.reason, 'upgrade_purchase'),
          like(currencyLedger.refId, '25:%'),
          gt(currencyLedger.id, marker!.id),
        ),
      );
    expect(since[0]?.spent).toBe(10);
  });

  it(`stops at ${maxStars} stars and puts them in the loadouts`, async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    await c.put('/api/save/partner', { dex: 25 });
    for (let star = 1; star <= maxStars; star++) {
      await maxAll(c);
      const res = await c.post('/api/save/prestige', { dex: 25 });
      expect(res.json()).toMatchObject({ prestige: { 25: star } });
    }
    await maxAll(c);
    const capped = await c.post('/api/save/prestige', { dex: 25 });
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toMatchObject({ error: { code: 'prestige_maxed' } });
    // The refused prestige changed nothing.
    expect((await c.get('/api/save')).json()).toMatchObject({
      prestige: { 25: maxStars },
      upgrades: { 25: { hp: 2, ban: 1 } },
    });

    const save = await getSave(t.db.db, c.userId);
    expect(partnerOf(save)).toEqual({ dex: 25, shiny: false, prestige: maxStars });
    expect((await loadLoadout(t.db.db, c.userId))?.config.prestige).toBe(maxStars);
  });

  it('applies one of two simultaneous prestiges', async () => {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    await maxAll(c);
    const results = await Promise.all([
      c.post('/api/save/prestige', { dex: 25 }),
      c.post('/api/save/prestige', { dex: 25 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      error: { code: 'prestige_not_ready' },
    });
    expect((await c.get('/api/save')).json()).toMatchObject({ prestige: { 25: 1 } });
    const audits = await t.db.db
      .select()
      .from(pokemonPrestiges)
      .where(eq(pokemonPrestiges.userId, c.userId));
    expect(audits).toHaveLength(1);
  });
});
