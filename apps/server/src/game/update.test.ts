// Stop-first deploys: on SIGTERM players get a warning (no new rooms or games), then running coop
// games are saved to the database and a new server instance restores them, waits for their
// players and resumes after a countdown. One that can't be restored is credited as saved.
import type { Results } from '@pokesurvivor/netclient';
import { stateHash, type SimState } from '@pokesurvivor/sim';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { gameRooms, gameSaves, runPlayers, runs } from '../db/schema.js';
import {
  createGameTestServer,
  lobby,
  sleep,
  startGame,
  waitFor,
  withTimeout,
  type GameTestServer,
} from '../test/bots.js';
import type { GameConfig } from '../config.js';

/** A new server instance on the old one's database (the old one has stopped). */
function nextServer(old: GameTestServer, game: Partial<GameConfig> = {}) {
  return createGameTestServer(
    { heartbeatMs: 200, restoreGraceMs: 5000, resumeCountdownMs: 300, ...game },
    { database: old.database, simDebug: { noSpawns: true, invulnerable: true } },
  );
}

/** Stops `old` for an update (its process exits). */
async function stop(old: GameTestServer, warningMs = 0): Promise<void> {
  await old.game.shutdown(warningMs);
  await old.app.close();
}

describe('server updates (stop-first)', () => {
  it('warns everyone with a countdown, refuses new rooms and games, and keeps coop running', async () => {
    const t = await createGameTestServer({ heartbeatMs: 200 });
    try {
      const players = await t.party(2);
      await lobby(players);
      await startGame(players);
      const lobbyBots = await t.party(2);
      await lobby(lobbyBots);
      const idle = await t.bot();
      await idle.connect();
      const notices = [...players, ...lobbyBots, idle].map((b) =>
        withTimeout(
          b.client.next('notice', (n) => n.code === 'server-update'),
          5000,
          `${b.username}: update notice`,
        ),
      );
      const before = Date.now();
      const stopped = t.game.shutdown(2000);
      for (const n of await Promise.all(notices)) {
        expect(n.deadline).toBeGreaterThanOrEqual(before + 2000);
        expect(n.deadline).toBeLessThanOrEqual(Date.now() + 2000);
      }
      // No new rooms or games…
      await expect(idle.client.createRoom()).rejects.toMatchObject({ code: 'server_draining' });
      await expect(lobbyBots[0]!.client.start()).rejects.toMatchObject({
        code: 'server_draining',
      });
      // …someone connecting now is told too, and stays connected until the end…
      const late = await t.bot();
      const lateNotice = late.client.next('notice', (n) => n.code === 'server-update');
      await late.connect();
      expect(late.client.draining).toBe(true);
      expect((await withTimeout(lateNotice, 2000, 'late notice')).deadline).toBe(
        (await notices[0])!.deadline,
      );
      // …while the coop run plays on.
      const tick = players[0]!.latest!.tick;
      await players[0]!.until((s) => s.tick > tick + 15 && !s.paused);
      expect(idle.client.state).toBe('open');
      await withTimeout(stopped, 10_000, 'shutdown');
      await waitFor(() => idle.client.state !== 'open', 'sockets closed at the end');
      const [saved] = await t.database.db.db.select().from(gameSaves);
      expect(saved!.game.present.sort()).toEqual(players.map((b) => b.userId).sort());
      // Nothing was credited: the run goes on after the update.
      expect(await t.database.db.db.select().from(runs)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it('saves a running game, and a new server restores it exactly, waits for everyone, then resumes', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    let next: GameTestServer | undefined;
    try {
      const bots = await old.party(3, (i) => ({ latencyMs: 10 + i * 10, jitterMs: 10 }));
      const id = await lobby(bots);
      await startGame(bots);
      bots.forEach((b) => b.wander());
      await bots[0]!.until((s) => s.time > 1 && s.ackSeq > 10);
      const oldGame = old.game.liveRooms.get(id)!.game!;
      // A level-up is pending when the server stops: the choice (and its timer) carries over.
      oldGame.sim.state.team.level += 1;
      oldGame.sim.state.pendingLevels += 1;
      await bots[0]!.until((s) => s.choices.length > 0);
      const choices = oldGame.sim.state.pendingChoices.map((c) => ({
        id: c.id,
        playerId: c.playerId,
        deadlineTick: c.deadlineTick,
      }));
      bots.forEach((b) => b.routeTo('ws://127.0.0.1:1/ws'));
      await stop(old);

      const [row] = await old.database.db.db.select().from(gameSaves);
      expect(row).toMatchObject({ gameId: oldGame.id, roomId: id, version: 1 });
      const savedHash = stateHash(JSON.parse(row!.sim) as SimState);
      expect(savedHash).toBe(oldGame.sim.hash());
      // The room is released for the next server, not handed over as a lobby.
      const [reservation] = await old.database.db.db
        .select()
        .from(gameRooms)
        .where(eq(gameRooms.id, id));
      expect(reservation).toMatchObject({ instanceId: null, handoff: null });

      next = await nextServer(old);
      // Restored before anyone connects: held, exactly as saved, and the row is gone.
      const room = next.game.liveRooms.get(id)!;
      const game = room.game!;
      expect(game.id).toBe(oldGame.id);
      expect(game.held).toBe(true);
      expect(game.sim.hash()).toBe(savedHash);
      expect(await next.database.db.db.select().from(gameSaves)).toEqual([]);

      const resuming = bots.map((b) =>
        withTimeout(
          b.client.next('notice', (n) => n.code === 'game-resuming'),
          10_000,
          `${b.username}: resume countdown`,
        ),
      );
      const waiting = bots[0]!.client.next('notice', (n) => n.code === 'game-waiting');
      // Two come back first: the game waits for the third.
      bots[2]!.net.offline = true;
      bots.forEach((b) => b.routeTo(next!.url));
      const w = await withTimeout(waiting, 10_000, 'waiting notice');
      expect(w.usernames).toContain(bots[2]!.username);
      expect(w.deadline).toBeGreaterThan(Date.now());
      await waitFor(() => bots[0]!.latest?.paused && bots[1]!.latest?.paused, 'held snapshots');
      // Nothing moves while held, and inputs sent meanwhile are dropped.
      game.input(bots[0]!.userId, { type: 'input', gameId: game.id, seq: 1e9, moveX: 1, moveY: 0 });
      await sleep(300);
      expect(game.held).toBe(true);
      expect(game.sim.hash()).toBe(savedHash);
      bots[2]!.net.offline = false;
      const [countdown] = await Promise.all(resuming);
      expect(countdown!.deadline).toBeGreaterThan(Date.now() - 100);
      await waitFor(() => !game.held, 'resumed');
      // The pending choice is still there, with its deadline unchanged in sim ticks.
      expect(
        game.sim.state.pendingChoices.map((c) => ({
          id: c.id,
          playerId: c.playerId,
          deadlineTick: c.deadlineTick,
        })),
      ).toEqual(choices);
      const picks = bots.map((b) => b.autoPick());
      // Play continues: time advances and every player's inputs are applied again.
      const time = game.sim.state.time;
      await Promise.all(
        bots.map((b) => b.until((s) => !s.paused && s.time > time + 1 && s.ackSeq > 5, 15_000)),
      );
      expect(game.sim.state.players.every((p) => p.connected && !p.left)).toBe(true);
      picks.forEach((off) => off());
      // It ends and is credited as usual (the run crediting is unchanged).
      const results = withTimeout(bots[0]!.client.next('results'), 10_000, 'results');
      game.forceEnd('all-down');
      expect(await results).toMatchObject({ credited: true, reason: 'all-down' });
      expect(await next.database.db.db.select().from(runs)).toHaveLength(1);
    } finally {
      await next?.close();
      await old.close();
    }
  });

  it('goes on without a player who is not back within the grace, as after a disconnect', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    let next: GameTestServer | undefined;
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      await startGame(bots);
      bots.forEach((b) => b.routeTo('ws://127.0.0.1:1/ws'));
      bots[1]!.net.offline = true;
      await stop(old);
      next = await nextServer(old, { restoreGraceMs: 600, reconnectGraceMs: 1000 });
      const game = next.game.liveRooms.get(id)!.game!;
      const resuming = bots[0]!.client.next('notice', (n) => n.code === 'game-resuming');
      const gone = bots[0]!.client.next('notice', (n) => n.code === 'player-disconnected');
      bots.forEach((b) => b.routeTo(next!.url));
      const started = Date.now();
      await withTimeout(resuming, 5000, 'countdown after the grace');
      expect(Date.now() - started).toBeGreaterThan(400);
      expect((await withTimeout(gone, 5000, 'disconnect notice')).usernames).toEqual([
        bots[1]!.username,
      ]);
      await waitFor(() => !game.held, 'resumed without them');
      const absent = () => game.sim.state.players.find((p) => p.id === bots[1]!.userId)!;
      expect(absent().connected).toBe(false);
      const time = game.sim.state.time;
      await bots[0]!.until((s) => !s.paused && s.time > time + 0.5);
      // Their usual reconnect grace runs out: removed from the game and the room.
      await waitFor(() => absent().left, 'removed after the reconnect grace', 5000);
      expect(next.game.liveRooms.get(id)!.members.has(bots[1]!.userId)).toBe(false);
    } finally {
      await next?.close();
      await old.close();
    }
  });

  it('credits a saved game it cannot restore, as saved, and gives its players their lobby back', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    let next: GameTestServer | undefined;
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      await startGame(bots);
      await bots[0]!.until((s) => s.time > 0.5);
      const oldGame = old.game.liveRooms.get(id)!.game!;
      bots.forEach((b) => b.routeTo('ws://127.0.0.1:1/ws'));
      await stop(old);
      const time = Math.floor(oldGame.sim.state.time);
      // An incompatible sim change: the saved state doesn't load any more.
      await old.database.db.db.update(gameSaves).set({ sim: '{"players":null}' });
      const results = bots.map((b) =>
        withTimeout(b.client.next('results'), 10_000, `${b.username}: results`),
      );
      next = await nextServer(old);
      expect(next.game.liveRooms.get(id)?.game ?? null).toBeNull();
      bots.forEach((b) => b.routeTo(next!.url));
      const [r] = (await Promise.all(results)) as Results[];
      expect(r).toMatchObject({ gameId: oldGame.id, credited: true, reason: 'server-shutdown' });
      const [run] = await next.database.db.db.select().from(runs);
      expect(run).toMatchObject({ mode: 'coop', durationS: time });
      expect(
        await next.database.db.db.select().from(runPlayers).where(eq(runPlayers.runId, run!.id)),
      ).toHaveLength(2);
      expect(await next.database.db.db.select().from(gameSaves)).toEqual([]);
      await waitFor(
        () =>
          bots.every(
            (b) => b.client.roomView?.id === id && b.client.roomView.phase === 'lobby',
          ),
        'their lobby back',
      );
    } finally {
      await next?.close();
      await old.close();
    }
  });

  it('restores a game on a server that was already running (a start-first deploy)', async () => {
    const old = await createGameTestServer({ heartbeatMs: 200 });
    const next = await nextServer(old);
    try {
      const bots = await old.party(2);
      const id = await lobby(bots);
      await startGame(bots);
      bots.forEach((b) => b.routeTo(next.url));
      const resumed = bots.map((b) =>
        withTimeout(
          b.client.next('notice', (n) => n.code === 'game-resuming'),
          10_000,
          'countdown on the running server',
        ),
      );
      await old.game.shutdown(300);
      await Promise.all(resumed);
      const game = await waitFor(() => next.game.liveRooms.get(id)?.game, 'restored game');
      await waitFor(() => !game.held, 'resumed');
      const time = game.sim.state.time;
      await bots[0]!.until((s) => !s.paused && s.time > time + 0.5);
    } finally {
      await next.close();
      await old.close();
    }
  });
});
