import { firstOption, SnapshotDecoder, type Snapshot } from '@pokesurvivor/netclient';
import { describe, expect, it } from 'vitest';
import { Game } from './game.js';
import type { Session } from './session.js';

function setup() {
  const snapshots: Snapshot[] = [];
  const decoder = new SnapshotDecoder(['a', 'b']);
  const session = {
    writable: true,
    send: () => {},
    sendBinary: (bytes: Uint8Array) => snapshots.push(decoder.decode(bytes)),
  } as unknown as Session;
  const game = new Game(
    'room',
    ['a', 'b'].map((id) => ({
      userId: id,
      username: id,
      loadout: { id, dex: 25 },
      owned: new Set<number>(),
    })),
    { snapshotHz: 20, choiceTimeoutS: 30, simDebug: { noSpawns: true, invulnerable: true } },
    (id) => (id === 'a' ? session : null),
    () => {},
  );
  // Both are present in the sim; only the first transport needs to be observed.
  game.start(['a', 'b']);
  game.reconnect('b', { ...session, sendBinary: () => {} } as unknown as Session);
  snapshots.length = 0;
  return { game, snapshots };
}

function openChoices(game: Game) {
  game.sim.state.pendingLevels++;
  game.tick();
  expect(game.sim.paused).toBe(true);
}

describe('snapshot pacing during choices', () => {
  it('sends a frozen-world heartbeat at 1 Hz while ticks and choice deadlines continue', () => {
    const { game, snapshots } = setup();
    openChoices(game);
    expect(snapshots).toHaveLength(1);
    const before = snapshots[0]!;
    for (let i = 0; i < 60; i++) game.tick();
    expect(snapshots).toHaveLength(3);
    for (const s of snapshots) {
      expect(s.paused).toBe(true);
      expect(s.time).toBe(before.time);
      expect(s.players.map((p) => [p.x, p.y])).toEqual(before.players.map((p) => [p.x, p.y]));
    }
    expect(snapshots.at(-1)!.tick - before.tick).toBe(60);
  });

  it('publishes a timed-out choice immediately even while another choice still pauses the game', () => {
    const { game, snapshots } = setup();
    openChoices(game);
    game.sim.state.pendingChoices[0]!.deadlineTick = game.sim.state.tick + 1;
    game.tick();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)!.paused).toBe(true);
    expect(snapshots.at(-1)!.waiting).toHaveLength(1);
    expect(snapshots.at(-1)!.events.some((e) => e.type === 'choice-resolved' && e.auto)).toBe(true);
  });

  it('sends choice mutations, resyncs and resume on the next tick without waiting for a heartbeat', () => {
    const { game, snapshots } = setup();
    openChoices(game);
    const first = game.sim.state.pendingChoices.find((c) => c.playerId === 'a')!;
    expect(game.intent('a', firstOption(first)!)).toEqual({ ok: true });
    game.tick();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)!.paused).toBe(true);
    expect(snapshots.at(-1)!.waiting.map((c) => c.playerId)).toEqual(['b']);
    game.resync('a');
    game.tick();
    expect(snapshots).toHaveLength(3);
    expect(snapshots.at(-1)!.full).toBe(true);
    const last = game.sim.state.pendingChoices.find((c) => c.playerId === 'b')!;
    expect(game.intent('b', firstOption(last)!)).toEqual({ ok: true });
    game.tick();
    expect(snapshots).toHaveLength(4);
    expect(snapshots.at(-1)!.paused).toBe(false);
    const count = snapshots.length;
    for (let i = 0; i < 30; i++) game.tick();
    expect(snapshots.length - count).toBe(20);
  });
});
