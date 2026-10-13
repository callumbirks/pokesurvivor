import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getServerData } from '../data.js';
import { currencyLedger, gachaPulls } from '../db/schema.js';
import type { SaveView } from '../saves/service.js';
import { withLockedSave } from '../saves/service.js';
import { createTestApp } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';
import type { PullResult } from './engine.js';

interface PullResponse {
  pullId: string;
  banner: string;
  results: PullResult[];
  pity: number;
  achievements: { id: string }[];
  save: SaveView;
}

interface GachaInfo {
  softPity: { from: number; stepPerPull: number };
  hardPity: number;
  rates: { rarity: number; weight: number }[];
  banners: { id: string; featured: number[]; pity: number | null; poolSize: object }[];
}

describe('gacha', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  async function withTickets(x1: number, x10 = 0) {
    const c = await t.newUser();
    await withLockedSave(t.db.db, c.userId, (save) => {
      save.wallet.credit('tickets_x1', x1, 'admin_adjustment');
      save.wallet.credit('tickets_x10', x10, 'admin_adjustment');
    });
    return c;
  }

  it('lists the banners, rates and featured Pokémon, with pity when logged in', async () => {
    const anon = (await t.client().get('/api/gacha')).json<GachaInfo>();
    const { gacha } = getServerData();
    expect(anon).toMatchObject({
      softPity: { from: 74, stepPerPull: 0.06 },
      hardPity: 90,
      rates: gacha.rates,
    });
    expect(anon.banners.map((b) => b.id)).toEqual(gacha.banners.map((b) => b.id));
    expect(anon.banners[0]).toMatchObject({ id: 'kanto', pity: null });
    expect(anon.banners[0]?.featured).toContain(150);

    const c = await withTickets(1);
    await c.post('/api/gacha/pull', { banner: 'johto', count: 1 });
    const mine = (await c.get('/api/gacha')).json<GachaInfo>();
    expect(mine.banners.find((b) => b.id === 'kanto')?.pity).toBe(0);
    expect(mine.banners.find((b) => b.id === 'johto')?.pity).toBeLessThanOrEqual(1);
  });

  it('pulls with tickets, records the pull and credits refunds through the ledger', async () => {
    const c = await withTickets(11, 1);
    const single = await c.post('/api/gacha/pull', { banner: 'kanto', count: 1 });
    expect(single.statusCode, single.body).toBe(200);
    const multi = await c.post('/api/gacha/pull', { banner: 'kanto', count: 10 });
    const multi10 = await c.post('/api/gacha/pull', {
      banner: 'kanto',
      count: 10,
      payWith: 'tickets10',
    });
    const bodies = [single, multi, multi10].map((r) => r.json<PullResponse>());
    expect(bodies.map((b) => b.results.length)).toEqual([1, 10, 10]);

    const save = bodies[2]!.save;
    expect(save.tickets.x10).toBe(0);
    expect(save.stats.pulls).toBe(21);
    expect(save.pity.kanto).toBe(bodies[2]!.pity);
    for (const r of bodies.flatMap((b) => b.results)) {
      expect(save.owned[String(r.dex)]).toBeDefined();
      if (r.shiny) expect(save.shiny[String(r.dex)]).toBeDefined();
      expect(getServerData().pokemonByDex.get(r.dex)?.gen).toBe(1);
    }
    // Each ×10 has a 4★ or better.
    for (const b of bodies.slice(1)) expect(b.results.some((r) => r.rarity >= 4)).toBe(true);

    const rows = await t.db.db.select().from(gachaPulls).where(eq(gachaPulls.userId, c.userId));
    expect(rows.map((r) => [r.count, r.payWith, r.cost]).sort()).toEqual([
      [1, 'tickets', 1],
      [10, 'tickets', 10],
      [10, 'tickets10', 1],
    ]);
    for (const body of bodies) {
      const ledger = await t.db.db
        .select()
        .from(currencyLedger)
        .where(eq(currencyLedger.refId, body.pullId));
      const refund = body.results.reduce((sum, r) => sum + r.refund, 0);
      expect(ledger.filter((l) => l.reason === 'gacha_refund').map((l) => l.delta)).toEqual(
        refund > 0 ? [refund] : [],
      );
      expect(ledger.filter((l) => l.reason === 'gacha_pull')).toHaveLength(1);
    }
    const all = await t.db.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, c.userId));
    const coins = all.filter((l) => l.currency === 'coins').reduce((s, l) => s + l.delta, 0);
    expect(save.coins).toBe(coins);
    const tickets = all.filter((l) => l.currency === 'tickets_x1');
    expect(save.tickets.x1).toBe(tickets.reduce((s, l) => s + l.delta, 0));
    expect(tickets.filter((l) => l.reason === 'gacha_pull').map((l) => l.delta)).toEqual([-1, -10]);
    // Owning 10+ Pokémon unlocks own-1 and own-10.
    expect(save.achievements).toHaveProperty('own-10');
  });

  it('rejects pulls it can’t pay for or that don’t exist', async () => {
    const c = await withTickets(5, 0);
    const cases: [object, number, string][] = [
      [{ banner: 'kanto', count: 10 }, 409, 'insufficient_funds'],
      [{ banner: 'kanto', count: 10, payWith: 'tickets10' }, 409, 'insufficient_funds'],
      [{ banner: 'kanto', count: 1, payWith: 'tickets10' }, 400, 'invalid_payment'],
      [{ banner: 'kanto', count: 5 }, 400, 'invalid_pull_count'],
      [{ banner: 'orre', count: 1 }, 400, 'unknown_banner'],
      [{ banner: 'kanto', count: 1, payWith: 'coins' }, 400, 'invalid_request'],
    ];
    for (const [body, status, code] of cases) {
      const res = await c.post('/api/gacha/pull', body);
      expect([res.statusCode, res.json<{ error: { code: string } }>().error.code]).toEqual([
        status,
        code,
      ]);
    }
    const save = (await c.get('/api/save')).json<SaveView>();
    expect(save.tickets.x1).toBe(5);
    expect(save.stats.pulls).toBe(0);
    expect(
      (await t.client().post('/api/gacha/pull', { banner: 'kanto', count: 1 })).statusCode,
    ).toBe(401);
  });

  it('spends each ticket once under concurrent pulls', async () => {
    const c = await withTickets(3);
    // Achievements pay tickets (a first shiny gives 3, at a 1% shiny rate per pull), which
    // would legitimately fund more pulls; mark them all unlocked so only the 3 tickets count.
    await withLockedSave(t.db.db, c.userId, (save) => {
      for (const a of getServerData().achievements.achievements) save.data.achievements[a.id] = 1;
    });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => c.post('/api/gacha/pull', { banner: 'hoenn', count: 1 })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    const save = (await c.get('/api/save')).json<SaveView>();
    expect(save.tickets.x1).toBe(0);
    expect(save.stats.pulls).toBe(3);
  });
});
