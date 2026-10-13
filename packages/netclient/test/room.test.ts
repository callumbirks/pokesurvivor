import { describe, expect, it } from 'vitest';
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
