// Friend activity in presence: the menus, solo runs (reported by their client, checked against
// the database) and coop games (from the server's own sim), and the rules for re-sending it.
import { emptyRunProgress, type FriendActivity } from '@pokesurvivor/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../db/schema.js';
import {
  createGameTestServer,
  lobby,
  startGame,
  waitFor,
  withTimeout,
  type Bot,
  type GameTestServer,
} from '../test/bots.js';
import { MAX_CLOCK_DRIFT_S, presenceDiffers, run, soloActivity } from './activity.js';

const finish = {
  durationS: 30,
  level: 1,
  kills: 0,
  bosses: 0,
  coins: 0,
  ticketsX1: 0,
  ticketsX10: 0,
  shiniesCaught: [],
  progress: emptyRunProgress(),
};

describe('presenceDiffers', () => {
  const solo = run('solo', 25, false, 100, false);
  const sent = { status: 'in_game' as const, activity: solo, at: 0 };

  it('ignores a clock that ticks as the friend expects', () => {
    expect(presenceDiffers(sent, 'in_game', run('solo', 25, false, 160, false), 60_000)).toBe(
      false,
    );
  });

  it('re-sends on a pause, a resume, drift, another Pokémon or kind', () => {
    const at = (s: number, paused = false, dex = 25) => run('solo', dex, false, s, paused);
    expect(presenceDiffers(sent, 'in_game', at(160, true), 60_000)).toBe(true);
    expect(presenceDiffers(sent, 'in_game', at(160 - MAX_CLOCK_DRIFT_S - 1), 60_000)).toBe(true);
    expect(presenceDiffers(sent, 'in_game', at(160, false, 4), 60_000)).toBe(true);
    expect(presenceDiffers(sent, 'online', { kind: 'menu' }, 60_000)).toBe(true);
    const paused = { ...sent, activity: at(100, true) };
    expect(presenceDiffers(paused, 'in_game', at(100, true), 60_000)).toBe(false);
    expect(presenceDiffers(paused, 'in_game', at(100), 60_000)).toBe(true);
  });

  it('caps a solo clock at the time since the run started', () => {
    const a = soloActivity(
      {
        runId: 'r',
        dex: 25,
        shiny: true,
        startedAt: 0,
        elapsedS: 500,
        paused: false,
        at: 0,
      },
      60_000,
    );
    expect(a).toEqual({ kind: 'solo', dex: 25, shiny: true, elapsedS: 60 });
  });
});

describe('friend activity', () => {
  let t: GameTestServer;
  beforeAll(async () => {
    t = await createGameTestServer();
  });
  afterAll(() => t.close());

  const seen = (watcher: Bot, friend: Bot) => ({
    status: watcher.client.friends.get(friend.username),
    activity: watcher.client.activities.get(friend.username)?.activity,
  });
  const post = (b: Bot, url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: { cookie: b.cookie }, payload });
  async function startSolo(b: Bot, startedSAgo = 600): Promise<string> {
    const res = await post(b, '/api/runs/start', { pokemon: { dex: 25, shiny: false } });
    expect(res.statusCode, res.body).toBe(201);
    const { runId } = res.json<{ runId: string }>();
    // Started a while ago, so the clock it reports isn't capped.
    await t.database.db.db
      .update(runs)
      .set({ startedAt: sql`now() - make_interval(secs => ${startedSAgo})` })
      .where(eq(runs.id, runId));
    return runId;
  }

  it('shows the menus, then a solo run with its Pokémon and clock, until it is reported', async () => {
    const [ash, misty] = await t.party(2);
    await waitFor(() => seen(ash!, misty!).status === 'online', 'misty online');
    expect(seen(ash!, misty!).activity).toEqual({ kind: 'menu' });

    const runId = await startSolo(misty!);
    misty!.client.setSoloClock({ runId, elapsedS: 215, paused: false });
    await waitFor(() => seen(ash!, misty!).activity?.kind === 'solo', 'misty in a solo run');
    const solo = seen(ash!, misty!);
    expect(solo.status).toBe('in_game');
    expect(solo.activity).toMatchObject({ kind: 'solo', dex: 25, shiny: false });
    expect((solo.activity as { elapsedS: number }).elapsedS).toBeCloseTo(215, 0);

    misty!.client.setSoloClock({ runId, elapsedS: 230, paused: true });
    await waitFor(
      () => (seen(ash!, misty!).activity as { paused?: true }).paused === true,
      'misty paused',
    );

    // A reconnect re-sends the clock.
    const back = misty!.client.next('welcome');
    misty!.drop();
    await back;
    await waitFor(
      () => seen(ash!, misty!).activity?.kind === 'solo' && t.game.isOnline(misty!.userId),
      'misty back in her run',
    );
    expect(paused(seen(ash!, misty!))).toBe(true);

    expect((await post(misty!, '/api/runs', { runId, ...finish })).statusCode).toBe(200);
    await waitFor(() => seen(ash!, misty!).activity?.kind === 'menu', 'misty back to the menu');
    expect(seen(ash!, misty!).status).toBe('online');
  });

  it('announces reconnect activity even when it arrives before the friend list loads', async () => {
    const [ash, misty] = await t.party(2);
    await waitFor(() => seen(ash!, misty!).status === 'online', 'friends loaded');
    const runId = await startSolo(misty!);
    misty!.client.setSoloClock({ runId, elapsedS: 30, paused: true });
    await waitFor(() => seen(ash!, misty!).activity?.kind === 'solo', 'initial solo activity');
    let unlocked!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlocked = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Hold only the friend-list SELECT; authentication and the solo lookup still run.
    const lock = t.database.db.db.transaction(async (tx) => {
      await tx.execute(sql`lock table friendships in access exclusive mode`);
      entered();
      await gate;
    });
    await ready;
    try {
      const welcomed = misty!.client.next('welcome');
      misty!.drop();
      await withTimeout(welcomed, 2000, 'reconnect welcome');
      await waitFor(
        () => t.game.sessionOf(misty!.userId)?.solo?.runId === runId,
        'activity applied while friends are loading',
      );
      expect(seen(ash!, misty!).activity?.kind).not.toBe('solo');
      const friendsLoaded = misty!.client.next('presence');
      const announcement = ash!.client.next(
        'presence',
        () => seen(ash!, misty!).activity?.kind === 'solo',
      );
      unlocked();
      await lock;
      await withTimeout(friendsLoaded, 2000, 'friend list after reconnect');
      await withTimeout(announcement, 2000, 'reconnect activity announcement');
      expect(seen(ash!, misty!)).toMatchObject({
        status: 'in_game',
        activity: { kind: 'solo', paused: true },
      });
    } finally {
      unlocked();
      await lock;
    }
  });

  it("ignores runs that aren't the player's, or aren't open", async () => {
    const [ash, misty, brock] = await t.party(3);
    const brocksRun = await startSolo(brock!);
    misty!.client.setSoloClock({ runId: brocksRun, elapsedS: 10, paused: false });
    misty!.client.setSoloClock({ runId: 'not-a-uuid', elapsedS: 10, paused: false });
    // A later message that is applied shows the earlier ones were handled (and ignored).
    misty!.client.setSoloClock(null);
    brock!.client.setSoloClock({ runId: brocksRun, elapsedS: 10, paused: false });
    await waitFor(() => seen(ash!, brock!).activity?.kind === 'solo', 'brock in his run');
    expect(seen(ash!, misty!).activity).toEqual({ kind: 'menu' });
  });

  it('falls back to the menu when an abandoned run is credited by the timeout', async () => {
    const [ash, misty] = await t.party(2);
    const runId = await startSolo(misty!);
    expect((await post(misty!, '/api/runs/checkpoint', { runId, ...finish })).statusCode).toBe(200);
    misty!.client.setSoloClock({ runId, elapsedS: 30, paused: false });
    await waitFor(() => seen(ash!, misty!).activity?.kind === 'solo', 'misty in a solo run');
    await t.database.db.db
      .update(runs)
      .set({ checkpointAt: sql`now() - interval '1 day'` })
      .where(eq(runs.id, runId));
    await t.app.runSweeper!.sweep();
    await waitFor(() => seen(ash!, misty!).activity?.kind === 'menu', 'misty back to the menu');

    // A tab that crashed and came back no longer reports the run.
    misty!.client.setSoloClock(null);
    misty!.client.close();
    await waitFor(() => seen(ash!, misty!).status === 'offline', 'misty offline');
    expect(seen(ash!, misty!).activity).toBeUndefined();
    await misty!.connect();
    await waitFor(() => seen(ash!, misty!).status === 'online', 'misty online again');
    expect(seen(ash!, misty!).activity).toEqual({ kind: 'menu' });
  });

  it("shows a coop game's Pokémon and the sim's run time", async () => {
    const [watcher, ash, misty] = await t.party(3, (i) => ({ dex: [1, 4, 7][i] }));
    // Only ash and misty play; the watcher is friends with both.
    await lobby([ash!, misty!]);
    await waitFor(() => seen(watcher!, misty!).status === 'in_lobby', 'misty in a room');
    expect(seen(watcher!, misty!).activity).toEqual({ kind: 'menu' });

    await startGame([ash!, misty!]);
    await waitFor(
      () => seen(watcher!, misty!).activity?.kind === 'coop' && !paused(seen(watcher!, misty!)),
      'misty in a running coop game',
    );
    expect(seen(watcher!, misty!)).toMatchObject({
      status: 'in_game',
      activity: { kind: 'coop', dex: 7, shiny: false },
    });
    expect(seen(watcher!, ash!).activity).toMatchObject({ kind: 'coop', dex: 4 });

    // The watcher's local clock follows the server's sim.
    await new Promise((r) => setTimeout(r, 1500));
    const game = t.game.roomOfUser(misty!.userId)!.game!;
    const entry = watcher!.client.activities.get(misty!.username)!;
    const a = entry.activity as Exclude<FriendActivity, { kind: 'menu' }>;
    const local = a.elapsedS + (Date.now() - entry.at) / 1000;
    expect(game.sim.state.time).toBeGreaterThan(1);
    expect(Math.abs(local - game.sim.state.time)).toBeLessThan(MAX_CLOCK_DRIFT_S + 0.5);

    await misty!.client.leaveRoom();
    await waitFor(() => seen(watcher!, misty!).activity?.kind === 'menu', 'misty left the game');
    expect(seen(watcher!, misty!).status).toBe('online');
  });
});

const paused = (p: { activity?: FriendActivity }) =>
  !!p.activity && p.activity.kind !== 'menu' && p.activity.paused === true;
