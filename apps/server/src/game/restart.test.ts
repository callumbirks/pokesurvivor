import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { roomRestartState, runPlayers, runs } from '../db/schema.js';
import { getSave } from '../saves/service.js';
import { createGameTestServer, lobby, startGame, waitFor, withTimeout } from '../test/bots.js';

describe('rooms across server restarts', () => {
  it('keeps the room code, host, members, partners and ready state; clients reconnect', async () => {
    const t = await createGameTestServer();
    try {
      const bots = await t.party(3);
      const id = await lobby(bots);
      await bots[1]!.client.setStatus('busy');
      const before = t.game.liveRooms.get(id)!.view();
      const states: string[] = [];
      bots[0]!.client.on('state', (s) => states.push(s));
      await t.restart(250);
      await waitFor(() => bots.every((b) => b.client.state === 'open'), 'automatic reconnect');
      await waitFor(() => bots.every((b) => b.client.roomView?.id === id), 'same room');
      const after = t.game.liveRooms.get(id)!.view();
      expect(after).toEqual(before);
      expect(states).toContain('reconnecting');
      expect(states.at(-1)).toBe('open');
      // Consumed on boot, so a crash cannot replay an old checkpoint into a later game.
      expect(await t.database.db.db.select().from(roomRestartState)).toEqual([]);
      // A second redeploy preserves the same room too.
      await t.restart();
      await waitFor(() => bots.every((b) => b.client.state === 'open'), 'second reconnect');
      expect(t.game.liveRooms.get(id)!.view()).toEqual(before);
    } finally {
      await t.close();
    }
  });

  it('ends an active run, credits everyone once and restores their lobby', async () => {
    const t = await createGameTestServer();
    try {
      const bots = await t.party(2);
      const id = await lobby(bots);
      await startGame(bots);
      const game = t.game.liveRooms.get(id)!.game!;
      // Earn known rewards without waiting for a long run in CI.
      game.sim.state.team.coins = 100;
      await bots[0]!.until((s) => s.time > 0.2);
      const before = await Promise.all(bots.map((b) => getSave(t.database.db.db, b.userId)));
      const results = bots.map((b) => withTimeout(b.client.next('results'), 5000, 'results'));
      await t.restart(250);
      for (const r of await Promise.all(results)) {
        expect(r).toMatchObject({ reason: 'server-shutdown', credited: true });
        expect(r.players).toHaveLength(2);
      }
      await waitFor(() => bots.every((b) => b.client.state === 'open'), 'reconnect to lobby');
      const room = t.game.liveRooms.get(id)!;
      expect(room.phase).toBe('lobby');
      expect(room.game).toBeNull();
      expect(room.ownerId).toBe(bots[0]!.userId);
      expect(room.view().members.every((m) => !m.inGame && m.status === 'not-ready')).toBe(true);
      const recorded = await t.database.db.db.select().from(runs).where(eq(runs.mode, 'coop'));
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.status).toBe('finished');
      expect(await t.database.db.db.select().from(runPlayers)).toHaveLength(2);
      for (const [i, b] of bots.entries()) {
        const save = await getSave(t.database.db.db, b.userId);
        expect(save.stats.groupRuns).toBe(before[i]!.stats.groupRuns + 1);
        expect(save.coins).toBeGreaterThan(before[i]!.coins);
      }
      await t.restart();
      expect(await t.database.db.db.select().from(runs)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('cancels a loading run while retaining the ready lobby', async () => {
    const t = await createGameTestServer();
    try {
      const bots = await t.party(2, { autoLoad: false });
      const id = await lobby(bots);
      await bots[0]!.client.start();
      expect(t.game.liveRooms.get(id)!.phase).toBe('loading');
      await t.restart();
      await waitFor(() => bots.every((b) => b.client.state === 'open'), 'loading reconnect');
      const room = t.game.liveRooms.get(id)!;
      expect(room.phase).toBe('lobby');
      expect(room.game).toBeNull();
      expect(room.view().members.every((m) => m.status === 'ready' && !m.inGame)).toBe(true);
      expect(await t.database.db.db.select().from(runs)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it('removes absent members through normal grace cleanup, transfers host and expires empty rooms', async () => {
    const t = await createGameTestServer({ restartReconnectGraceMs: 700 });
    try {
      const bots = await t.party(2);
      const id = await lobby(bots);
      bots[0]!.net.offline = true;
      await t.restart();
      await waitFor(() => bots[1]!.client.state === 'open', 'guest reconnect');
      await waitFor(() => t.game.liveRooms.get(id)?.members.size === 1, 'absent owner expires');
      expect(t.game.liveRooms.get(id)!.ownerId).toBe(bots[1]!.userId);
      bots[1]!.net.offline = true;
      await t.restart();
      await waitFor(() => t.game.liveRooms.size === 0, 'empty room expires');
    } finally {
      await t.close();
    }
  });

  it('rejects new work as soon as shutdown begins and saves only after run settlement', async () => {
    const t = await createGameTestServer();
    try {
      const bots = await t.party(1);
      const id = await lobby(bots);
      const stopped = t.game.shutdown();
      expect(t.game.draining).toBe(true);
      expect(t.game.shutdown()).toBe(stopped);
      await stopped;
      const refused = await t.app.inject({ method: 'GET', url: '/api/info' });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ error: { code: 'server_draining' } });
      const [saved] = await t.database.db.db.select().from(roomRestartState);
      expect(saved!.rooms.map((r) => r.id)).toEqual([id]);
      expect(saved!.rooms[0]!.members[0]!.status).toBe('ready');
    } finally {
      await t.close();
    }
  });
});
