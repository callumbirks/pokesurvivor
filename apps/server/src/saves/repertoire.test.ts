import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData, pokemonOf } from '../data.js';
import { pokemonPrestiges, saves } from '../db/schema.js';
import { loadLoadout } from '../game/loadout.js';
import { createTestApp, grantGems, grantPokemon } from '../test/harness.js';
import type { TestApp, TestClient } from '../test/harness.js';
import { getSave } from './service.js';

interface SaveBody {
  repertoireMoves: Record<string, string>;
  moveBans: Record<string, string[]>;
  upgrades: Record<string, Record<string, number>>;
}

describe('Repertoire: the chosen second starting move', () => {
  let t: TestApp;
  const data = getServerData();
  const pikachu = pokemonOf(25);
  const startingMove = data.startingMoveOf(pikachu);
  const attacks = data
    .movePoolOf(pikachu)
    .filter((m) => m.id !== startingMove && m.kind !== 'buff')
    .map((m) => m.id);
  const [chosen, other] = attacks as [string, string];
  const buff = data.movePoolOf(pikachu).find((m) => m.kind === 'buff')!.id;
  const outside = data.moves.moves.find(
    (m) => !data.movePoolOf(pikachu).some((p) => p.id === m.id),
  )!.id;

  beforeAll(async () => {
    t = await createTestApp({
      economy: {
        startingCoins: 10_000,
        upgrades: {
          'extra-move': { maxLevel: 1, baseCost: 10, growth: 1 },
          ban: { maxLevel: 1, baseCost: 10, growth: 1 },
        },
      },
    });
  });
  afterAll(() => t.close());

  async function owner(upgrades: string[] = ['extra-move']) {
    const c = await t.newUser();
    await grantPokemon(t.db, c.userId, [{ dex: 25 }]);
    await c.put('/api/save/partner', { dex: 25 });
    for (const upgradeId of upgrades)
      expect((await c.post('/api/save/upgrades', { dex: 25, upgradeId })).statusCode).toBe(200);
    return c;
  }

  const choose = (c: TestClient, repertoire: string | null, dex = 25) =>
    c.put(`/api/save/moves/${dex}`, { repertoire });

  it('saves the choice, which the co-op loadout carries, and null goes back to random', async () => {
    const c = await owner();
    const res = await choose(c, chosen);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<SaveBody>().repertoireMoves).toEqual({ 25: chosen });
    expect((await c.get('/api/save')).json<SaveBody>().repertoireMoves).toEqual({ 25: chosen });
    expect((await loadLoadout(t.db.db, c.userId))?.config.secondMove).toBe(chosen);

    expect((await choose(c, other)).json<SaveBody>().repertoireMoves).toEqual({ 25: other });
    expect((await choose(c, null)).json<SaveBody>().repertoireMoves).toEqual({});
    expect((await loadLoadout(t.db.db, c.userId))?.config).not.toHaveProperty('secondMove');
  });

  it('refuses Pokémon not owned or without Repertoire, and moves it cannot start with', async () => {
    const c = await owner([]);
    expect((await choose(c, chosen, 4)).json()).toMatchObject({
      error: { code: 'pokemon_not_owned' },
    });
    expect((await choose(c, chosen)).json()).toMatchObject({
      error: { code: 'repertoire_not_bought' },
    });
    expect((await choose(c, null)).statusCode).toBe(409);

    await c.post('/api/save/upgrades', { dex: 25, upgradeId: 'extra-move' });
    for (const id of [startingMove, outside, buff, 'no-such-move']) {
      const res = await choose(c, id);
      expect(res.statusCode, id).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_move' } });
    }
    expect((await c.get('/api/save')).json<SaveBody>().repertoireMoves).toEqual({});
  });

  it('refuses a banned move, and banning the chosen move clears the choice', async () => {
    const c = await owner(['extra-move', 'ban']);
    await c.put('/api/save/moves/25', { bans: [other] });
    expect((await choose(c, other)).json()).toMatchObject({ error: { code: 'move_banned' } });

    await choose(c, chosen);
    // Banning another move keeps it.
    expect((await c.put('/api/save/moves/25', { bans: [other] })).json()).toMatchObject({
      repertoireMoves: { 25: chosen },
    });
    const banned = (await c.put('/api/save/moves/25', { bans: [chosen] })).json<SaveBody>();
    expect(banned.moveBans).toEqual({ 25: [chosen] });
    expect(banned.repertoireMoves).toEqual({});

    // Bans apply first in one request: unban and choose at once works.
    const both = await c.put('/api/save/moves/25', { bans: [], repertoire: chosen });
    expect(both.json<SaveBody>().repertoireMoves).toEqual({ 25: chosen });
    expect(
      (await c.put('/api/save/moves/25', { bans: [other], repertoire: other })).json(),
    ).toMatchObject({ error: { code: 'move_banned' } });
  });

  it('prestige clears the choice and records it', async () => {
    const c = await owner(['extra-move', 'ban']);
    await choose(c, chosen);
    await grantGems(t.db, c.userId, data.tuning.gems.prestigeCost);
    const res = await c.post('/api/save/prestige', { dex: 25 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<SaveBody>().repertoireMoves).toEqual({});
    const [audit] = await t.db.db
      .select()
      .from(pokemonPrestiges)
      .where(eq(pokemonPrestiges.userId, c.userId));
    expect(audit?.reset).toMatchObject({ repertoireMove: chosen });
    expect((await choose(c, chosen)).json()).toMatchObject({
      error: { code: 'repertoire_not_bought' },
    });
  });

  it('reads version 3 saves, which have none', async () => {
    const c = await owner();
    await t.db.db
      .update(saves)
      .set({ dataVersion: 3, data: sql`${saves.data} - 'repertoireMoves'` })
      .where(eq(saves.userId, c.userId));
    expect((await getSave(t.db.db, c.userId)).repertoireMoves).toEqual({});
    expect((await choose(c, chosen)).json<SaveBody>().repertoireMoves).toEqual({ 25: chosen });
  });
});
