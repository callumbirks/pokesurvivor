import { TICK_MS, WorldView, createSim, playerMoveSpeed, type Sim } from '@pokesurvivor/sim';
import { describe, expect, it } from 'vitest';
import { Predictor, type PendingInput, type ServerBody } from './predict.js';

/**
 * A server (a real sim at 30 Hz, applying the latest input that arrived each tick, like the game
 * server) and a client rendering at 60 fps with `upMs` / `downMs` of latency each way.
 */
function harness(opts: { seed?: number; upMs: number; downMs: number; snapshotEvery?: number }) {
  const sim = createSim({
    seed: opts.seed ?? 3,
    players: [{ id: 'me', dex: 25 }],
    debug: { noSpawns: true, invulnerable: true },
  });
  const me = sim.state.players[0]!;
  const view = new WorldView(sim.state.world.seed);
  const predictor = new Predictor(view, me.r, me.types);
  let now = 0;
  let seq = 0;
  let unacked: PendingInput[] = [];
  const inFlight: { at: number; input: PendingInput }[] = [];
  const snapshots: { at: number; ack: number; body: ServerBody; speed: number }[] = [];
  let latest = { ack: 0, body: body(sim), speed: playerMoveSpeed(sim.state, me) };
  let applied: PendingInput | null = null;
  /** Server position after each input seq it applied (the truth to predict). */
  const truth = new Map<number, { x: number; y: number }>();
  let nextTick = 0;
  let nextInput = 0;
  let ticks = 0;

  function body(s: Sim): ServerBody {
    const p = s.state.players[0]!;
    return { x: p.x, y: p.y, vx: p.vx, vy: p.vy, inLiquid: p.inLiquid };
  }

  /** What we drew at the end of each input's tick (the blend fully at that input). */
  const drawn = new Map<number, { x: number; y: number }>();

  /** Runs the client for `ms` with `input` held. */
  function run(ms: number, input: { moveX: number; moveY: number }, each?: () => void) {
    const end = now + ms;
    for (; now < end; now += 1000 / 60) {
      if (nextInput <= now && seq > 0) {
        // Where we draw at the very end of the newest input's tick.
        predictor.update({
          server: latest.body,
          ackSeq: latest.ack,
          unacked,
          speed: latest.speed,
          now: nextInput,
          active: true,
        });
        drawn.set(seq, { x: predictor.x, y: predictor.y });
      }
      while (nextInput <= now) {
        const i = { seq: ++seq, ...input, sentAt: nextInput };
        unacked.push(i);
        inFlight.push({ at: nextInput + opts.upMs, input: i });
        nextInput += TICK_MS;
      }
      while (nextTick <= now) {
        while (inFlight[0] && inFlight[0].at <= nextTick) applied = inFlight.shift()!.input;
        if (applied) sim.setInput('me', applied);
        sim.step();
        ticks++;
        const ack = applied?.seq ?? 0;
        truth.set(ack, { x: me.x, y: me.y });
        if (ticks % (opts.snapshotEvery ?? 2) === 0)
          snapshots.push({
            at: nextTick + opts.downMs,
            ack,
            body: body(sim),
            speed: playerMoveSpeed(sim.state, me),
          });
        nextTick += TICK_MS;
      }
      while (snapshots[0] && snapshots[0].at <= now) {
        latest = snapshots.shift()!;
        unacked = unacked.filter((i) => i.seq > latest.ack);
        view.setRecords(sim.state.world as unknown as Record<string, Record<string, number>>);
      }
      predictor.update({
        server: latest.body,
        ackSeq: latest.ack,
        unacked,
        speed: latest.speed,
        now,
        active: true,
      });
      each?.();
    }
  }

  return {
    sim,
    me,
    predictor,
    run,
    truth,
    /** The largest gap between what we drew for an input and where the server ended up. */
    maxError(): number {
      let max = 0;
      for (const [k, d] of drawn) {
        const t = truth.get(k);
        if (t) max = Math.max(max, Math.hypot(t.x - d.x, t.y - d.y));
      }
      return max;
    },
    /** The server's position after the newest input it applied. */
    latestTruth() {
      return truth.get(Math.max(...truth.keys()))!;
    },
    get seq() {
      return seq;
    },
    get now() {
      return now;
    },
  };
}

describe('client-side prediction', () => {
  it('shows the position the server will reach, ahead of the snapshots', () => {
    const h = harness({ upMs: 60, downMs: 60 });
    h.run(300, { moveX: 0, moveY: 0 });
    // Walking right for 2 s with 120 ms of round trip: the server lags ~4 ticks behind, but what
    // we drew for each input is where the server put us once it applied it.
    h.run(2000, { moveX: 1, moveY: 0 });
    h.run(400, { moveX: 0, moveY: 0 });
    const t = h.latestTruth();
    expect(Math.hypot(t.x - h.predictor.x, t.y - h.predictor.y)).toBeLessThan(0.5);
    expect(h.maxError()).toBeLessThan(0.5);
    expect(h.me.x).toBeGreaterThan(150);
    expect(Math.abs(h.predictor.offX) + Math.abs(h.predictor.offY)).toBeLessThan(0.5);
  });

  it('runs ahead of the server by the round trip while walking', () => {
    const h = harness({ upMs: 80, downMs: 80 });
    let lead = 0;
    h.run(1500, { moveX: 0, moveY: 1 }, () => {
      lead = h.predictor.y - h.me.y;
    });
    // The server is ~80 ms (input in flight) behind what we draw: ~2–3 ticks at ~4 units each.
    expect(lead).toBeGreaterThan(4);
    expect(lead).toBeLessThan(20);
  });

  it('collides with walls and props exactly like the server', () => {
    const h = harness({ seed: 11, upMs: 50, downMs: 50 });
    // Walk diagonally for a long time: on this map that scrapes along walls, trees and water.
    for (const [x, y] of [
      [1, 1],
      [-1, 0.4],
      [0.2, -1],
      [1, -0.3],
    ] as const)
      h.run(4000, { moveX: x, moveY: y });
    h.run(500, { moveX: 0, moveY: 0 });
    const t = h.latestTruth();
    expect(Math.hypot(t.x - h.predictor.x, t.y - h.predictor.y)).toBeLessThan(0.5);
    expect(h.maxError()).toBeLessThan(0.5);
    expect(Math.hypot(h.me.x, h.me.y)).toBeGreaterThan(200);
  });

  it('eases a server correction out instead of snapping, and snaps a teleport', () => {
    const h = harness({ upMs: 40, downMs: 40 });
    h.run(500, { moveX: 0, moveY: 0 });
    const before = h.predictor.x;
    // The server pushes us 30 units (knockback the client didn't predict).
    h.me.x += 30;
    let firstJump = 0;
    let frames = 0;
    h.run(1000, { moveX: 0, moveY: 0 }, () => {
      if (frames++ === 8) firstJump = h.predictor.x - before;
    });
    expect(firstJump).toBeLessThan(30); // eased, not snapped (the snapshot arrives by frame 8)
    expect(h.predictor.x - before).toBeCloseTo(30, 0); // and converges
    // A teleport (arena) snaps at once.
    h.me.x += 2000;
    h.run(200, { moveX: 0, moveY: 0 });
    expect(Math.abs(h.predictor.x - h.me.x)).toBeLessThan(1);
  });

  it('predicts nothing while inactive (paused, down): the server position is used', () => {
    const view = new WorldView(1);
    const p = new Predictor(view, 12, ['electric']);
    const server = { x: 10, y: 20, vx: 0, vy: 0, inLiquid: false };
    const unacked = [{ seq: 1, moveX: 1, moveY: 0, sentAt: 0 }];
    p.update({ server, ackSeq: 0, unacked, speed: 110, now: 100, active: false });
    expect([p.x, p.y]).toEqual([10, 20]);
    p.update({ server, ackSeq: 0, unacked, speed: 110, now: 200, active: true });
    expect(p.x).toBeGreaterThan(10);
  });
});

describe('prediction guard', () => {
  it('snaps to the server when it ignores our inputs for over a second, and warns', () => {
    const sim = createSim({ seed: 3, players: [{ id: 'me', dex: 25 }], debug: { noSpawns: true } });
    const me = sim.state.players[0]!;
    const predictor = new Predictor(new WorldView(sim.state.world.seed), me.r, me.types);
    const server: ServerBody = { x: me.x, y: me.y, vx: 0, vy: 0, inLiquid: false };
    const speed = playerMoveSpeed(sim.state, me);
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      // The server never acks (the stuck-at-spawn bug): inputs pile up, the prediction walks off.
      const unacked: PendingInput[] = [];
      let now = 0;
      for (let i = 1; i <= 75; i++, now += TICK_MS) {
        unacked.push({ seq: i, moveX: 1, moveY: 0, sentAt: now });
        predictor.update({ server, ackSeq: 0, unacked, speed, now, active: true });
        if (now < 900) expect(predictor.fallback).toBe(false);
      }
      expect(predictor.fallback).toBe(true);
      expect(predictor.x).toBe(server.x);
      expect(warnings).toHaveLength(1);
      // Inputs get applied again: prediction resumes.
      predictor.update({ server, ackSeq: 75, unacked: [], speed, now, active: true });
      expect(predictor.fallback).toBe(false);
    } finally {
      console.warn = warn;
    }
  });
});
