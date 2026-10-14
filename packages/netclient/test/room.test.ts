import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSim } from '@pokesurvivor/sim';
import type { InputMessage } from '@pokesurvivor/protocol';
import { NetRoomConnection } from '../src/room.js';
import { SnapshotEncoder, isFullFrame } from '../src/snapshot.js';
import type { Game } from '../src/types.js';
import { botStep, lateGame } from './late-game.js';

describe('NetRoomConnection', () => {
  it('asks for a full snapshot after a frame it can’t apply, and skips deltas until then', () => {
    const sim = lateGame(1);
    const sent: { type: string }[] = [];
    const room = new NetRoomConnection('p0', {
      send: (m) => (sent.push(m), true),
      request: () => Promise.resolve(),
      now: () => 0,
    });
    const game = {
      gameId: 'g1',
      players: sim.state.players.map((p) => ({ id: p.id, index: p.index })),
    } as unknown as Game;
    room.handleStart(game, false);
    const enc = new SnapshotEncoder({ viewerId: 'p0' });
    const frame = () => {
      botStep(sim);
      return enc.encode(sim.state, sim.drainEvents(), sim.state.tick, 0) as Uint8Array;
    };
    expect(room.handleFrame(frame(), 0)?.full).toBe(true);
    frame(); // lost: the next delta doesn't apply
    let lost = 0;
    for (let i = 0; i < 5; i++) if (!room.handleFrame(frame(), 0)) lost++;
    expect(sent).toContainEqual({ type: 'game.resync', gameId: 'g1' });
    expect(lost).toBeGreaterThan(0);
    enc.reset(); // what the server does on game.resync
    const full = frame();
    expect(isFullFrame(full)).toBe(true);
    const snap = room.handleFrame(full, 0);
    expect(snap?.full).toBe(true);
    expect(room.handleFrame(frame(), 0)?.tick).toBe(sim.state.tick);
  });
});

describe('input pacing', () => {
  afterEach(() => vi.useRealTimers());
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sent: InputMessage[] = [];
    const room = new NetRoomConnection('p0', {
      now: () => Date.now(),
      send: (m) => {
        if (m.type === 'input') sent.push(m);
        return true;
      },
      request: () => Promise.resolve(),
    });
    const sim = createSim({ seed: 1, players: [{ id: 'p0', dex: 25 }], debug: { noSpawns: true } });
    const game = { gameId: 'g1', players: [{ id: 'p0', index: 0 }] } as unknown as Game;
    room.handleStart(game, false);
    const enc = new SnapshotEncoder({ viewerId: 'p0' });
    let seq = 0;
    const snapshot = (ack = 0) =>
      room.handleFrame(enc.encode(sim.state, [], ++seq, ack) as Uint8Array, Date.now());
    snapshot();
    return { room, sent, sim, snapshot, game };
  }

  it('samples changing input no faster than the simulation rate, independent of rendering', () => {
    const { room, sent } = setup();
    let reads = 0;
    const stop = room.startInputLoop(() => ({ moveX: ++reads % 2, moveY: 0 }));
    vi.advanceTimersByTime(1000);
    expect(sent.length).toBeGreaterThan(25);
    expect(sent.length).toBeLessThanOrEqual(30);
    stop();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(reads);
  });

  it('sends changes and keepalives, comparing aim on the wire grid and preserving slot presses', () => {
    const { room, sent } = setup();
    const held = { moveX: 1, moveY: 0, aim: 1, fire: true };
    room.sendInput(held);
    vi.advanceTimersByTime(100);
    room.sendInput({ ...held, aim: 1.00001 });
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(150);
    room.sendInput(held);
    expect(sent).toHaveLength(2);
    room.sendInput({ ...held, fire: false });
    room.sendInput({ ...held, slot: 1 });
    room.sendInput({ ...held, slot: 1 });
    expect(sent).toHaveLength(5);
    expect(sent.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sends neutral movement once while paused, then immediately sends held input on resume', () => {
    const { room, sent, sim, snapshot } = setup();
    room.startInputLoop(() => ({ moveX: 1, moveY: 0, aim: 1, fire: true }));
    vi.advanceTimersByTime(100);
    sim.state.pendingLevels++;
    sim.step();
    expect(snapshot()?.paused).toBe(true);
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toMatchObject({ moveX: 0, moveY: 0 });
    expect(sent.at(-1)?.fire).toBeUndefined();
    const count = sent.length;
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(count);
    sim.state.pendingChoices = [];
    snapshot();
    vi.advanceTimersByTime(34);
    expect(sent).toHaveLength(count + 1);
    expect(sent.at(-1)).toMatchObject({ moveX: 1, fire: true });
    room.setPhase('ended');
  });

  it('retains acknowledged held movement and resets the timeline on a resumed start', () => {
    const { room, snapshot, game } = setup();
    room.sendInput({ moveX: 1, moveY: 0 });
    snapshot(1);
    expect(room.unackedInputs()).toEqual([]);
    expect(room.ackedInput).toMatchObject({ seq: 1, moveX: 1, sentAt: 0 });
    room.handleStart(game, true);
    expect(room.ackedInput).toBeNull();
    expect(room.ackedInputSeq).toBe(0);
    expect(room.sendInput({ moveX: 1, moveY: 0 })).toBe(1);
  });
});
