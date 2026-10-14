import { and, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { gameRoomMembers, gameRooms, runs } from '../db/schema.js';
import { getSave } from '../saves/service.js';
import {
  createGameTestServer,
  lobby,
  makeFriends,
  sleep,
  startGame,
  waitFor,
  withTimeout,
  type GameTestServer,
} from '../test/bots.js';

async function replacement(t: GameTestServer) {
  return createGameTestServer(
    { heartbeatMs: 200, reconnectGraceMs: 3000, restartReconnectGraceMs: 1500 },
    {
      database: t.database,
      simDebug: { noSpawns: true, invulnerable: true },
    },
  );
}

describe('start-first room handoffs', () => {
  it('snapshots at SIGTERM, after the replacement is up and prior lobby requests settle', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    const next = await replacement(old);
    try {
      const bots = await old.party(3);
      const id = await lobby(bots.slice(0, 2));
      // The replacement is already serving; the old lobby remains fully mutable until SIGTERM.
      await bots[0]!.client.invite(bots[2]!.username);
      await bots[2]!.client.join(id);
      await bots[1]!.client.leaveRoom();
      await bots[2]!.client.setStatus('busy');
      await old.game.flush();
      const before = old.game.liveRooms.get(id)!.view();
      for (const b of bots) b.routeTo(next.url);
      const states: string[] = [];
      bots[0]!.client.on('state', (s) => states.push(s));
      await old.game.drain(2000);
      await waitFor(
        () => next.game.roomOfUser(bots[0]!.userId)?.id === id,
        'adoption on already-running replacement',
      );
      await waitFor(
        () =>
          [bots[0], bots[2]].every(
            (b) => next.game.isOnline(b!.userId) && b!.client.state === 'open',
          ),
        'member reconnects',
      );
      expect(next.game.liveRooms.get(id)!.view()).toEqual(before);
      expect(old.game.liveRooms.has(id)).toBe(false);
      expect(next.game.roomOfUser(bots[1]!.userId)).toBeNull();
      expect(states).toContain('reconnecting');
      expect(
        await old.database.db.db.select().from(gameRooms).where(isNotNull(gameRooms.handoff)),
      ).toEqual([]);
      // Changes after adoption belong to the new server and aren't overwritten by another poll.
      await bots[2]!.client.leaveRoom();
      await next.game.flush();
      await sleep(100);
      expect(next.game.liveRooms.get(id)!.members.size).toBe(1);
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('rejects new lobby changes after SIGTERM until the handoff commits', async () => {
    const old = await createGameTestServer();
    try {
      const bots = await old.party(1);
      const id = await lobby(bots);
      const room = old.game.liveRooms.get(id)!;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const publish = old.game.registry.handoff.bind(old.game.registry);
      vi.spyOn(old.game.registry, 'handoff').mockImplementation(async (...args) => {
        await gate;
        await publish(...args);
      });
      const drained = old.game.drain(1000);
      expect(room.transferring).toBe(true);
      const status = bots[0]!.client.setStatus('busy');
      const left = bots[0]!.client.leaveRoom();
      await expect(status).rejects.toMatchObject({ code: 'server_draining' });
      await expect(left).rejects.toMatchObject({ code: 'server_draining' });
      expect(room.member(bots[0]!.userId).status).toBe('ready');
      release();
      await drained;
      const [saved] = await old.database.db.db.select().from(gameRooms).where(eq(gameRooms.id, id));
      expect(saved!.handoff!.members[0]!.status).toBe('ready');
    } finally {
      await old.close();
    }
  });

  it('lets an old game continue, then hands off its current members and credits rewards once', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    const next = await replacement(old);
    try {
      const bots = await old.party(3);
      const id = await lobby(bots);
      await startGame(bots);
      const game = old.game.liveRooms.get(id)!.game!;
      for (const b of bots) {
        b.routeTo(next.url);
        b.wander();
      }
      const before = await getSave(old.database.db.db, bots[0]!.userId);
      const drained = old.game.drain(5000);
      const tick = bots[0]!.latest!.tick;
      await bots[0]!.until((s) => s.tick > tick + 15 && s.ackSeq > 5);
      expect(game.phase).toBe('running');
      expect(next.game.liveRooms.has(id)).toBe(false);
      // Leaving during the drain still follows the original game path.
      await bots[2]!.client.leaveRoom();
      expect(game.sim.state.players.find((p) => p.id === bots[2]!.userId)!.left).toBe(true);
      const results = bots[0]!.client.next('results');
      game.forceEnd('all-down');
      expect(await withTimeout(results, 5000, 'normal results')).toMatchObject({
        reason: 'all-down',
        credited: true,
      });
      await drained;
      await waitFor(
        () => next.game.liveRooms.get(id)?.members.size === 2,
        'lobby after game finish',
      );
      await waitFor(
        () =>
          [bots[0], bots[1]].every(
            (b) => next.game.isOnline(b!.userId) && b!.client.state === 'open',
          ),
        'players back',
      );
      expect(
        next.game.liveRooms
          .get(id)!
          .view()
          .members.every((m) => !m.inGame && m.status === 'not-ready'),
      ).toBe(true);
      expect(next.game.roomOfUser(bots[2]!.userId)).toBeNull();
      expect(await old.database.db.db.select().from(runs)).toHaveLength(1);
      expect((await getSave(old.database.db.db, bots[0]!.userId)).stats.groupRuns).toBe(
        before.stats.groupRuns + 1,
      );
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('keeps a reconnecting player reserved while the old game drains; polls for its eventual lobby', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200, reconnectGraceMs: 3000 });
    const next = await replacement(old);
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      await startGame(bots);
      const game = old.game.liveRooms.get(id)!.game!;
      bots.forEach((b) => b.routeTo(next.url));
      const drained = old.game.drain(5000);
      const pending = bots[1]!.client.next('notice', (n) => n.code === 'room-handoff-pending');
      bots[1]!.client.dropConnection();
      await withTimeout(pending, 3000, 'waiting notice');
      await expect(bots[1]!.client.createRoom()).rejects.toMatchObject({ code: 'room_pending' });
      await expect(bots[1]!.client.join(id)).rejects.toMatchObject({ code: 'room_pending' });
      const solo = await next.app.inject({
        method: 'POST',
        url: '/api/runs/start',
        headers: { cookie: bots[1]!.cookie },
        payload: { pokemon: { dex: 25, shiny: false } },
      });
      expect(solo.statusCode).toBe(409);
      const inviter = await next.bot();
      await makeFriends(old.database, [inviter, bots[1]!]);
      await inviter.connect();
      await inviter.client.createRoom();
      await expect(inviter.client.invite(bots[1]!.username)).rejects.toMatchObject({
        code: 'room_pending',
      });
      expect(game.sim.state.players.find((p) => p.id === bots[1]!.userId)!.connected).toBe(false);
      game.forceEnd('all-down');
      await drained;
      await waitFor(
        () =>
          bots[1]!.client.roomView?.id === id && next.game.roomOfUser(bots[1]!.userId)?.id === id,
        'pending member adopted without another reconnect',
      );
      expect(
        await old.database.db.db
          .select()
          .from(gameRoomMembers)
          .where(eq(gameRoomMembers.userId, bots[1]!.userId)),
      ).toHaveLength(1);
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('cancels loading and retains a ready lobby across a sequential restart too', async () => {
    const t = await createGameTestServer({ heartbeatMs: 200 });
    try {
      const bots = await t.party(2, { autoLoad: false });
      const id = await lobby(bots);
      await bots[0]!.client.start();
      await t.restart(100);
      await waitFor(
        () =>
          bots.every(
            (b) =>
              b.client.roomView?.id === id &&
              t.game.isOnline(b.userId) &&
              b.client.state === 'open',
          ),
        'loading room adopted',
      );
      const room = t.game.liveRooms.get(id)!;
      expect(room.phase).toBe('lobby');
      expect(room.game).toBeNull();
      expect(room.view().members.every((m) => m.status === 'ready' && !m.inGame)).toBe(true);
      expect(await t.database.db.db.select().from(runs)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it('expires unclaimed handoffs without resurrecting them and frees their member reservations', async () => {
    const old = await createGameTestServer({ restartReconnectGraceMs: 250 });
    const next = await replacement(old);
    try {
      const bots = await old.party(1);
      const id = await lobby(bots);
      bots[0]!.routeTo(next.url);
      bots[0]!.net.offline = true;
      await old.game.drain(1000);
      await waitFor(
        async () =>
          (await old.database.db.db.select().from(gameRooms).where(eq(gameRooms.id, id))).length ===
          0,
        'expired handoff',
      );
      expect(next.game.liveRooms.size).toBe(0);
      bots[0]!.net.offline = false;
      await waitFor(
        () => next.game.isOnline(bots[0]!.userId) && bots[0]!.client.state === 'open',
        'late reconnect',
      );
      const created = await bots[0]!.client.createRoom();
      expect(created.id).not.toBe(id);
      expect(next.game.liveRooms.has(id)).toBe(false);
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('uses shared uniqueness to reject competing memberships and room code collisions', async () => {
    const old = await createGameTestServer();
    const next = await replacement(old);
    try {
      const bots = await old.party(2);
      const id = await lobby([bots[0]!]);
      expect(await next.game.registry.create(id, bots[1]!.userId)).toBe('code_taken');
      expect(await next.game.registry.create('different', bots[0]!.userId)).toBe('member_taken');
      expect(
        await old.database.db.db.select().from(gameRooms).where(eq(gameRooms.id, 'different')),
      ).toEqual([]);
      expect(
        await old.database.db.db
          .select()
          .from(gameRoomMembers)
          .where(and(eq(gameRoomMembers.userId, bots[0]!.userId), eq(gameRoomMembers.roomId, id))),
      ).toHaveLength(1);
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('allows only one instance to consume the same handoff', async () => {
    const old = await createGameTestServer();
    const next = await replacement(old);
    const contender = await replacement(old);
    try {
      const bots = await old.party(1);
      const id = await lobby(bots);
      bots[0]!.net.offline = true;
      await old.game.drain(1000);
      const claimed = await Promise.all([
        next.game.registry.adopt(id),
        contender.game.registry.adopt(id),
      ]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
      const [row] = await old.database.db.db.select().from(gameRooms).where(eq(gameRooms.id, id));
      expect(row!.handoff).toBeNull();
      expect(row!.instanceId).toBe(
        claimed[0] ? next.game.registry.instanceId : contender.game.registry.instanceId,
      );
    } finally {
      await contender.close();
      await next.close();
      await old.close();
    }
  });

  it('includes an in-flight join in the SIGTERM snapshot after the request settles', async () => {
    const old = await createGameTestServer();
    const next = await replacement(old);
    try {
      const bots = await old.party(2);
      const id = await lobby([bots[0]!]);
      await bots[0]!.client.invite(bots[1]!.username);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const join = old.game.registry.join.bind(old.game.registry);
      vi.spyOn(old.game.registry, 'join').mockImplementation(async (...args) => {
        entered();
        await gate;
        return join(...args);
      });
      const joining = bots[1]!.client.join(id);
      await started;
      bots.forEach((b) => b.routeTo(next.url));
      const drained = old.game.drain(1000);
      release();
      await joining;
      await drained;
      await waitFor(() => next.game.liveRooms.get(id)?.members.size === 2, 'settled join adopted');
      expect(next.game.roomOfUser(bots[1]!.userId)?.id).toBe(id);
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('keeps normal in-game disconnect grace, and tells the new client when that membership expires', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200, reconnectGraceMs: 250 });
    const next = await replacement(old);
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      await startGame(bots);
      const game = old.game.liveRooms.get(id)!.game!;
      bots.forEach((b) => b.routeTo(next.url));
      const drained = old.game.drain(3000);
      const expired = bots[1]!.client.next('notice', (n) => n.code === 'room-handoff-expired');
      bots[1]!.client.dropConnection();
      await withTimeout(expired, 3000, 'normal old grace expiry');
      expect(game.sim.state.players.find((p) => p.id === bots[1]!.userId)!.left).toBe(true);
      const fresh = await bots[1]!.client.createRoom();
      game.forceEnd('all-down');
      await drained;
      await waitFor(
        () => next.game.roomOfUser(bots[0]!.userId)?.id === id,
        'remaining lobby adopted',
      );
      expect(next.game.roomOfUser(bots[1]!.userId)?.id).toBe(fresh.id);
      expect(next.game.liveRooms.get(id)!.members.has(bots[1]!.userId)).toBe(false);
    } finally {
      await next.close();
      await old.close();
    }
  });

  it('transfers host after adoption when an absent member never rejoins', async () => {
    const old = await createGameTestServer();
    const next = await replacement(old);
    next.game.config.restartReconnectGraceMs = 250;
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      bots.forEach((b) => b.routeTo(next.url));
      bots[0]!.net.offline = true;
      await old.game.drain(1000);
      await waitFor(() => next.game.liveRooms.get(id)?.members.size === 1, 'absent owner expires');
      expect(next.game.liveRooms.get(id)!.ownerId).toBe(bots[1]!.userId);
    } finally {
      await next.close();
      await old.close();
    }
  });
});
