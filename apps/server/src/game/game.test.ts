// Bot scenarios over real WebSockets: the legacy multiplayer bugs must be impossible (stuck
// level-ups, the gacha-start ghost, permanent disconnects), plus loading, reconnects, owners
// leaving, results and deploys. Bots have injected latency and jitter.
import type { Results } from '@pokesurvivor/netclient';
import { CloseCode } from '@pokesurvivor/protocol';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPlayers, runs } from '../db/schema.js';
import { getSave } from '../saves/service.js';
import {
  createGameTestServer,
  lobby,
  sleep,
  startGame,
  waitFor,
  withTimeout,
  type Bot,
  type GameTestServer,
} from '../test/bots.js';
import type { Game } from './game.js';

const laggy = (i: number) => ({ latencyMs: 20 + i * 15, jitterMs: 20 });

function serverGame(t: GameTestServer, bot: Bot): Game {
  const game = t.game.roomOfUser(bot.userId)?.game;
  if (!game) throw new Error('no game');
  return game;
}

/** Opens a round of level-up cards on the next tick (as if the team had the XP). */
function levelUp(game: Game): void {
  game.sim.state.team.level += 1;
  game.sim.state.pendingLevels += 1;
}

/** Everyone in the run goes down: it ends ~1.6 s later. */
function wipe(game: Game): void {
  game.sim.state.config.invulnerable = false;
  for (const p of game.sim.state.players) {
    p.hp = 0;
    p.dead = true;
  }
}

async function playing(t: GameTestServer, n: number, opts = laggy): Promise<Bot[]> {
  const bots = await t.party(n, opts);
  await lobby(bots);
  await startGame(bots);
  for (const b of bots) b.wander();
  return bots;
}

describe('coop games over the network', () => {
  let t: GameTestServer;
  beforeAll(async () => {
    t = await createGameTestServer({ reconnectGraceMs: 4000, choiceTimeoutS: 30 });
  });
  afterAll(() => t.close());

  it('runs the authoritative loop: inputs are applied and acked, snapshots flow', async () => {
    const bots = await playing(t, 2);
    const [a] = bots;
    const start = a!.latest!;
    expect(start.players).toHaveLength(2);
    const game = serverGame(t, a!);
    const before = game.sim.state.players.map((p) => [p.x, p.y]);
    await a!.until((s) => s.tick > start.tick + 30 && s.ackSeq > 10);
    const after = game.sim.state.players.map((p) => [p.x, p.y]);
    expect(after).not.toEqual(before);
    // The server's view of our Pokémon (prediction hook) follows the server.
    const self = a!.client.room!.serverSelf!;
    expect(self.id).toBe(a!.userId);
    expect(a!.client.room!.unackedInputs().length).toBeLessThan(30);
    await waitFor(() => a!.client.stats().snapshotsPerSecond > 10, 'snapshot rate');
    for (const b of bots) await b.client.leaveRoom();
  });

  it('level-up with one of 4 disconnected: no stall, their choice resolves by itself', async () => {
    const bots = await playing(t, 4);
    const [a, b, c, d] = bots;
    for (const bot of [a, b, c]) bot!.autoPick(50);
    const game = serverGame(t, a!);
    const back = d!.client.next('snapshot', (x) => x.full);
    d!.drop({ offlineMs: 2500 });
    await waitFor(
      () => !game.sim.state.players.find((p) => p.id === d!.userId)?.connected,
      'd idle',
    );
    levelUp(game);
    const paused = await a!.until((s) => s.paused);
    expect(paused.waiting.map((w) => w.playerId)).not.toContain(d!.userId);
    const tick = paused.tick;
    // Resolved: the game runs again without d.
    const resumed = await a!.until(
      (s) => !s.paused && s.waiting.length === 0 && s.tick > tick + 10,
    );
    expect(resumed.team.level).toBe(2);
    // d comes back, gets a full snapshot, and plays on.
    await withTimeout(back, 8000, 'd resumed');
    d!.wander();
    await d!.until((s) => !s.full && s.ackSeq > 5);
    expect(game.sim.state.players.find((p) => p.id === d!.userId)?.connected).toBe(true);
    for (const bot of bots) await bot.client.leaveRoom();
  });

  it('level-up with everyone connected waits for the last pick, whenever it comes', async () => {
    const bots = await playing(t, 4);
    const delays = [0, 300, 900, 1600];
    bots.forEach((bot, i) => bot.autoPick(delays[i]));
    const game = serverGame(t, bots[0]!);
    levelUp(game);
    const first = await bots[0]!.until((s) => s.paused);
    expect(first.waiting).toHaveLength(4);
    // Each one's own cards are in their snapshot; the others only see who's choosing.
    for (const bot of bots) {
      const s = await bot.until((x) => x.paused && x.choices.length > 0);
      expect(s.choices.every((c) => c.playerId === bot.userId)).toBe(true);
    }
    const waiting = await bots[0]!.until((s) => s.waiting.length === 1);
    expect(waiting.paused).toBe(true);
    expect(waiting.waiting[0]!.playerId).toBe(bots[3]!.userId);
    const done = await bots[0]!.until((s) => !s.paused, 6000);
    expect(done.waiting).toEqual([]);
    // Picked cards, not auto-resolved ones.
    const resolved = bots[0]!.snapshots
      .flatMap((s) => s.events)
      .filter((e) => e.type === 'choice-resolved');
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(game.sim.state.pendingChoices).toEqual([]);
    for (const bot of bots) await bot.client.leaveRoom();
  });

  it('reconnects mid-choice and mid-run, and resumes with a full snapshot', async () => {
    const bots = await playing(t, 2);
    const [a, b] = bots;
    a!.autoPick(0);
    const game = serverGame(t, a!);
    levelUp(game);
    await b!.until((s) => s.choices.length > 0);
    // b drops while its cards are up: they resolve (default card) and the game goes on.
    const resolved = a!.client.next('snapshot', (s) =>
      s.events.some((e) => e.type === 'choice-resolved' && e.playerId === b!.userId),
    );
    b!.drop({ offlineMs: 600 });
    const snap = await withTimeout(resolved, 5000, 'b’s choice resolved');
    expect(
      snap.events.find((e) => e.type === 'choice-resolved' && e.playerId === b!.userId),
    ).toMatchObject({ auto: true });
    await a!.until((s) => !s.paused && s.tick > snap.tick);
    // Back: a full snapshot with the current state, and its inputs count again.
    const resumed = await b!.until((s) => s.full, 8000);
    expect(resumed.team.level).toBe(game.sim.state.team.level);
    b!.wander();
    b!.autoPick(0);
    await b!.until((s) => s.ackSeq > 5 && !s.full);
    // The next level-up is picked by b itself.
    levelUp(game);
    await a!.until((s) => s.paused);
    await a!.until((s) => !s.paused && s.team.level === 3, 6000);
    for (const bot of bots) await bot.client.leaveRoom();
  });

  it('the owner leaving mid-run doesn’t stop the others', async () => {
    const bots = await playing(t, 3);
    const [owner, b, c] = bots;
    const game = serverGame(t, b!);
    const owned = b!.client.next('notice', (n) => n.code === 'owner-changed');
    await owner!.client.leaveRoom();
    await withTimeout(owned, 5000, 'owner change');
    const tick = b!.latest!.tick;
    await b!.until((s) => s.tick > tick + 60);
    expect(game.sim.state.players.find((p) => p.id === owner!.userId)?.left).toBe(true);
    expect(b!.client.roomView?.ownerId).toBe(b!.userId);
    expect(c!.client.roomView?.members.map((m) => m.userId)).not.toContain(owner!.userId);
    for (const bot of [b, c]) await bot!.client.leaveRoom();
  });

  it('records the run when it ends and credits every player, including one who left', async () => {
    const bots = await playing(t, 3);
    const [a, b, quitter] = bots;
    const game = serverGame(t, a!);
    await a!.until((s) => s.time > 1);
    await quitter!.client.leaveRoom();
    await a!.until((s) => s.time > 2);
    const before = await Promise.all(bots.map((bot) => getSave(t.database.db.db, bot.userId)));
    const results = [a, b].map((bot) =>
      withTimeout(bot!.client.next('results'), 15_000, 'results'),
    );
    wipe(game);
    const [ra, rb] = (await Promise.all(results)) as [Results, Results];
    expect(ra).toEqual(rb);
    expect(ra.credited).toBe(true);
    expect(ra.reason).toBe('all-down');
    expect(ra.players.map((p) => [p.userId, p.left]).sort()).toEqual(
      [
        [a!.userId, false],
        [b!.userId, false],
        [quitter!.userId, true],
      ].sort(),
    );
    const quit = ra.players.find((p) => p.userId === quitter!.userId)!;
    const stayed = ra.players.find((p) => p.userId === a!.userId)!;
    expect(quit.summary.run.durationS).toBeLessThan(stayed.summary.run.durationS);
    const quitSave = await getSave(t.database.db.db, quitter!.userId);
    expect(quitSave.stats.bestGroupTimeS).toBe(quit.summary.run.durationS);

    const rows = await t.database.db.db
      .select()
      .from(runPlayers)
      .where(eq(runPlayers.runId, ra.runId!));
    expect(rows.map((r) => r.userId).sort()).toEqual(bots.map((bot) => bot.userId).sort());
    const [run] = await t.database.db.db
      .select()
      .from(runs)
      .where(inArray(runs.id, [ra.runId!]));
    expect(run).toMatchObject({ mode: 'coop', status: 'finished' });
    for (const [i, bot] of bots.entries()) {
      const save = await getSave(t.database.db.db, bot.userId);
      expect(save.stats.groupRuns).toBe(before[i]!.stats.groupRuns + 1);
      expect(save.coins).toBeGreaterThanOrEqual(before[i]!.coins);
    }
    // Everyone still in the room is back in the lobby, not ready.
    await waitFor(() => a!.client.roomView?.phase === 'lobby', 'back to the lobby');
    expect(a!.client.roomView?.members.every((m) => m.status === 'not-ready' && !m.inGame)).toBe(
      true,
    );
    for (const bot of [a, b]) await bot!.client.leaveRoom();
  });

  it('removes a player whose grace runs out; a run with everyone gone ends and is credited', async () => {
    const t2 = await createGameTestServer({ reconnectGraceMs: 500 });
    try {
      const bots = await t2.party(2);
      await lobby(bots);
      await startGame(bots);
      const game = serverGame(t2, bots[0]!);
      bots[1]!.drop({ offlineMs: 60_000 });
      await waitFor(
        () => game.sim.state.players.find((p) => p.id === bots[1]!.userId)?.left,
        'b removed',
        5000,
      );
      await waitFor(() => bots[0]!.client.roomView?.members.length === 1, 'b out of the room');
      // Now everyone drops: the run is frozen, then ends when the grace runs out.
      const time = game.sim.state.time;
      bots[0]!.drop({ offlineMs: 60_000 });
      await sleep(200);
      expect(game.sim.state.time).toBeCloseTo(time, 0);
      await waitFor(() => game.phase === 'ended', 'the run ends', 5000);
      await waitFor(() => t2.game.liveRooms.size === 0, 'the room closes', 10_000);
      const coopRuns = () => t2.database.db.db.select().from(runs).where(eq(runs.mode, 'coop'));
      for (let i = 0; i < 50 && (await coopRuns()).length === 0; i++) await sleep(100);
      expect(await coopRuns()).toHaveLength(1);
    } finally {
      await t2.close();
    }
  });
});

describe('loading', () => {
  it('drops members who never ack loading, returns them to the lobby and tells everyone', async () => {
    const t = await createGameTestServer({ loadingTimeoutMs: 800 });
    try {
      const bots = await t.party(3, (i) => ({ ...laggy(i), autoLoad: i !== 2 }));
      await lobby(bots);
      const notices = bots.map((b) =>
        b.client.next('notice', (n) => n.code === 'dropped-at-loading'),
      );
      const started = bots.slice(0, 2).map((b) => b.client.next('start'));
      await bots[0]!.client.start();
      await withTimeout(Promise.all(started), 5000, 'start');
      for (const n of await Promise.all(notices)) expect(n.usernames).toEqual([bots[2]!.username]);
      const game = serverGame(t, bots[0]!);
      expect(game.sim.state.players.map((p) => p.id).sort()).toEqual(
        [bots[0]!.userId, bots[1]!.userId].sort(),
      );
      // The dropped one is not shown as playing (the legacy ghost) and keeps their room.
      await waitFor(() => bots[0]!.client.roomView?.phase === 'running', 'running');
      const ghost = bots[0]!.client.roomView!.members.find((m) => m.userId === bots[2]!.userId)!;
      expect(ghost).toMatchObject({ inGame: false, status: 'not-ready' });
      expect(t.game.statusOf([bots[2]!.userId]).get(bots[2]!.userId)).toBe('in_lobby');
      expect(t.game.statusOf([bots[0]!.userId]).get(bots[0]!.userId)).toBe('in_game');
      await waitFor(
        () => bots[2]!.client.room?.phase === 'ended',
        'the ghost’s game connection ends',
      );
    } finally {
      await t.close();
    }
  });

  it('cancels the game when nobody loads', async () => {
    const t = await createGameTestServer({ loadingTimeoutMs: 500 });
    try {
      const bots = await t.party(2, { autoLoad: false });
      await lobby(bots);
      const cancelled = bots[0]!.client.next('notice', (n) => n.code === 'game-cancelled');
      await bots[0]!.client.start();
      await withTimeout(cancelled, 5000, 'cancel');
      expect(t.game.roomOfUser(bots[0]!.userId)?.phase).toBe('lobby');
    } finally {
      await t.close();
    }
  });
});

describe('deploys', () => {
  it('drains on SIGTERM: no new rooms, games finish, then the rest end credited', async () => {
    const t = await createGameTestServer();
    try {
      const players = await t.party(2);
      await lobby(players);
      await startGame(players);
      const idle = await t.bot();
      await idle.connect();
      const notice = players[0]!.client.next('notice', (n) => n.code === 'server-draining');
      const results = players.map((b) => withTimeout(b.client.next('results'), 10_000, 'results'));
      const idleClosed = idle.client.next('state', (s) => s === 'reconnecting');
      const drained = t.game.drain(1500);
      expect((await withTimeout(notice, 5000, 'drain notice')).deadline).toBeGreaterThan(
        Date.now(),
      );
      // Clients outside a game are sent away (to reconnect to the new instance)…
      await withTimeout(idleClosed, 5000, 'idle client closed');
      // …and a reconnecting one can't start anything here.
      await waitFor(() => idle.client.state === 'open', 'idle back');
      expect(idle.client.draining).toBe(true);
      await expect(idle.client.createRoom()).rejects.toMatchObject({ code: 'server_draining' });
      // The running game is still going…
      const tick = players[0]!.latest!.tick;
      await players[0]!.until((s) => s.tick > tick + 15);
      // …until the drain timeout ends it, crediting both.
      const [r] = await Promise.all(results);
      expect(r).toMatchObject({ reason: 'server-shutdown', credited: true });
      await withTimeout(drained, 5000, 'drain');
      await waitFor(() => players[0]!.client.state !== 'open', 'sockets closed');
      expect(players[0]!.client.state).toBe('reconnecting');
      void CloseCode;
    } finally {
      await t.close();
    }
  });

  it('a drain finishes early once the last game ends', async () => {
    const t = await createGameTestServer();
    try {
      const players = await t.party(1);
      await lobby(players);
      await startGame(players);
      const drained = t.game.drain(20_000);
      await sleep(300);
      wipe(serverGame(t, players[0]!));
      const started = Date.now();
      await withTimeout(drained, 10_000, 'drain');
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await t.close();
    }
  });
});
