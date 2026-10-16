import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData, pokemonOf } from '../data.js';
import { currencyLedger } from '../db/schema.js';
import { createTestApp, grantGems, grantPokemon } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';

interface SaveBody {
  coins: number;
  gems: number;
  upgrades: Record<string, Record<string, number>>;
  prestige: Record<string, number>;
  moveBans: Record<string, string[]>;
  moveBindings: Record<string, (string | null)[]>;
  repertoireMoves: Record<string, string>;
}

describe('upgrade resets', () => {
  let t: TestApp;
  const data = getServerData();
  const { resetCost, prestigeCost } = data.tuning.gems;
  const pikachu = pokemonOf(25);
  const startingMove = data.startingMoveOf(pikachu);
  const [banned, chosen] = data
    .movePoolOf(pikachu)
    .filter((m) => m.id !== startingMove && m.kind !== 'buff')
    .map((m) => m.id) as [string, string];
  // hp: 10, 20 (growth 2); ban and Repertoire: 30 each. Everything maxed: 90 coins.
  const upgrades = {
    hp: { maxLevel: 2, baseCost: 10, growth: 2 },
    ban: { maxLevel: 1, baseCost: 30, growth: 1 },
    'extra-move': { maxLevel: 1, baseCost: 30, growth: 1 },
  };

  beforeAll(async () => {
    t = await createTestApp({ economy: { startingCoins: 10_000, upgrades } });
  });
  afterAll(() => t.close());

  async function owner(gems = resetCost) {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }, { dex: 4 }]);
    await grantGems(t.db, c.userId, gems);
    return c;
  }

  async function buy(c: TestClient, ids: string[], dex = 25): Promise<SaveBody> {
    for (const upgradeId of ids)
      expect((await c.post('/api/save/upgrades', { dex, upgradeId })).statusCode).toBe(200);
    return (await c.get('/api/save')).json<SaveBody>();
  }

  const quote = async (c: TestClient, dex = 25) =>
    (await c.get(`/api/save/upgrades/reset/${dex}`)).json<{ refund: number; cost: number }>();
  const reset = (c: TestClient, dex = 25) => c.post('/api/save/upgrades/reset', { dex });

  it('refunds the coins spent, clears Repertoire and Ban, keeps bindings and stars', async () => {
    const c = await owner(resetCost + 5);
    const before = (await c.get('/api/save')).json<SaveBody>();
    await buy(c, ['hp', 'hp', 'ban', 'extra-move']);
    await buy(c, ['hp'], 4); // another Pokémon's upgrades are not refunded
    const bindings = [startingMove, null, banned, null];
    const moves = await c.put('/api/save/moves/25', {
      bans: [banned],
      bindings,
      repertoire: chosen,
    });
    expect(moves.statusCode, moves.body).toBe(200);
    expect(await quote(c)).toEqual({ dex: 25, refund: 90, cost: resetCost });

    const res = await reset(c);
    expect(res.statusCode, res.body).toBe(200);
    const save = res.json<SaveBody>();
    expect(save.coins).toBe(before.coins - 10); // only Charmander's upgrade stays paid for
    expect(save.gems).toBe(5);
    expect(save.upgrades).toEqual({ 4: { hp: 1 } });
    expect(save.moveBans[25]).toBeUndefined();
    expect(save.repertoireMoves[25]).toBeUndefined();
    expect(save.moveBindings[25]).toEqual(bindings);

    const ledger = await t.db.db
      .select()
      .from(currencyLedger)
      .where(and(eq(currencyLedger.userId, c.userId), eq(currencyLedger.refId, '25:reset')))
      .orderBy(currencyLedger.id);
    expect(ledger).toMatchObject([
      { currency: 'gems', delta: -resetCost, balanceAfter: 5, reason: 'upgrade_reset_cost' },
      { currency: 'coins', delta: 90, balanceAfter: save.coins, reason: 'upgrade_refund' },
    ]);
    // Bought again after the reset: only that counts for the next one.
    await buy(c, ['hp']);
    expect((await quote(c)).refund).toBe(10);
  });

  it('refunds only what was bought since the last prestige, and keeps the stars', async () => {
    const c = await owner(resetCost + prestigeCost);
    await buy(c, ['hp', 'hp', 'ban', 'extra-move']);
    expect((await c.post('/api/save/prestige', { dex: 25 })).statusCode).toBe(200);
    expect((await quote(c)).refund).toBe(0);
    const bought = await buy(c, ['hp', 'hp']);
    expect((await quote(c)).refund).toBe(30);

    const save = (await reset(c)).json<SaveBody>();
    expect(save.coins).toBe(bought.coins + 30);
    expect(save.prestige).toEqual({ 25: 1 });
    expect(save.upgrades[25]).toBeUndefined();
    expect(save.gems).toBe(0);
  });

  it('refuses with nothing to refund, short of gems, or a Pokémon not owned', async () => {
    const c = await owner(resetCost - 1);
    const nothing = await reset(c);
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ error: { code: 'nothing_to_refund' } });

    const bought = await buy(c, ['hp', 'ban']);
    const short = await reset(c);
    expect(short.statusCode).toBe(409);
    expect(short.json()).toMatchObject({ error: { code: 'insufficient_gems' } });
    // Nothing changed.
    expect((await c.get('/api/save')).json()).toMatchObject({
      coins: bought.coins,
      gems: resetCost - 1,
      upgrades: { 25: { hp: 1, ban: 1 } },
    });

    for (const res of [await reset(c, 1), await c.get('/api/save/upgrades/reset/1')]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'pokemon_not_owned' } });
    }
    expect((await c.post('/api/save/upgrades/reset', {})).statusCode).toBe(400);
  });

  it('applies one of two simultaneous resets', async () => {
    const c = await owner(resetCost * 2);
    const bought = await buy(c, ['hp', 'hp']);
    const results = await Promise.all([reset(c), reset(c)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      error: { code: 'nothing_to_refund' },
    });
    expect((await c.get('/api/save')).json()).toMatchObject({
      coins: bought.coins + 30,
      gems: resetCost,
    });
  });
});
