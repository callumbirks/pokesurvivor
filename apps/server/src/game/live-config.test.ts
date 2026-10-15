// Live tuning in coop: each game plays with the config published when it started, to the end,
// across a server update too, and its run records that version.
import { loadGameData } from '@pokesurvivor/data';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runs } from '../db/schema.js';
import type { LiveConfig } from '../live-config/store.js';
import {
  createGameTestServer,
  lobby,
  startGame,
  withTimeout,
  type Bot,
  type GameTestServer,
} from '../test/bots.js';

const base = loadGameData();
/** Valid changes (the values themselves don't matter). */
const capOf = (n: number) => base.tuning.spawner.cap + n;

async function publish(t: GameTestServer, by: Bot, n: number): Promise<number> {
  const live = t.app.liveConfig as LiveConfig;
  const v = await live.publish(t.database.db.db, {
    overrides: { tuning: { spawner: { cap: capOf(n) } } },
    createdBy: by.userId,
    note: null,
  });
  return v.version;
}

async function finish(t: GameTestServer, bots: Bot[], roomId: string): Promise<void> {
  const results = withTimeout(bots[0]!.client.next('results'), 10_000, 'results');
  t.game.liveRooms.get(roomId)!.game!.forceEnd('all-down');
  await results;
}

describe('live tuning in coop games', () => {
  it('starts new games with the newest config while running ones keep theirs', async () => {
    const t = await createGameTestServer({ heartbeatMs: 200 });
    try {
      const first = await t.party(2);
      const firstRoom = await lobby(first);
      const v1 = await publish(t, first[0]!, 1);
      const started = first[1]!.client.next('start');
      await startGame(first);
      // The clients get the config with the game (for prediction and the HUD).
      expect((await started).game.config).toMatchObject({
        version: v1,
        tuning: { spawner: { cap: capOf(1) } },
      });
      const running = t.game.liveRooms.get(firstRoom)!.game!;
      expect(running.sim.ctx.d.game.tuning.spawner.cap).toBe(capOf(1));

      const v2 = await publish(t, first[0]!, 2);
      const second = await t.party(2);
      const secondRoom = await lobby(second);
      await startGame(second);
      const next = t.game.liveRooms.get(secondRoom)!.game!;
      expect(next.info.config?.version).toBe(v2);
      expect(next.sim.ctx.d.game.tuning.spawner.cap).toBe(capOf(2));
      // The running game is unchanged.
      expect(running.info.config?.version).toBe(v1);
      expect(running.sim.ctx.d.game.tuning.spawner.cap).toBe(capOf(1));

      await finish(t, first, firstRoom);
      await finish(t, second, secondRoom);
      const recorded = await t.database.db.db
        .select({ teamKey: runs.teamKey, configVersion: runs.configVersion })
        .from(runs)
        .where(eq(runs.mode, 'coop'));
      const versionOf = (bots: Bot[]) =>
        recorded.find((r) => r.teamKey.includes(bots[0]!.userId))?.configVersion;
      expect(versionOf(first)).toBe(v1);
      expect(versionOf(second)).toBe(v2);
    } finally {
      await t.close();
    }
  });

  it('restores a game saved for an update with the config it started with', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    let next: GameTestServer | undefined;
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      const v1 = await publish(old, bots[0]!, 1);
      await startGame(bots);
      const hash = old.game.liveRooms.get(id)!.game!.sim.hash();
      // Published while the game runs: it isn't the game's.
      await publish(old, bots[0]!, 2);
      bots.forEach((b) => b.routeTo('ws://127.0.0.1:1/ws'));
      await old.game.shutdown(0);
      await old.app.close();

      next = await createGameTestServer(
        { heartbeatMs: 200, restoreGraceMs: 5000, resumeCountdownMs: 300 },
        { database: old.database, simDebug: { noSpawns: true, invulnerable: true } },
      );
      const game = next.game.liveRooms.get(id)!.game!;
      expect(game.tuning.version).toBe(v1);
      expect(game.info.config?.version).toBe(v1);
      expect(game.sim.ctx.d.game.tuning.spawner.cap).toBe(capOf(1));
      expect(game.sim.hash()).toBe(hash);

      const resumed = bots[0]!.client.next('start');
      bots.forEach((b) => b.routeTo(next!.url));
      expect((await withTimeout(resumed, 10_000, 'resume')).game.config?.version).toBe(v1);
      await finish(next, bots, id);
      const [run] = await next.database.db.db.select().from(runs);
      expect(run?.configVersion).toBe(v1);
    } finally {
      await next?.close();
      await old.close();
    }
  });
});
