import type { MemberStatus, RoomView } from '@pokesurvivor/protocol';
import { describe, expect, it } from 'vitest';
import { BusyStatus } from './busy.js';

/** A fake room server: applies `room.status` and pushes the room back, like the real one. */
function setup(initial: MemberStatus = 'ready', opts: { manual?: boolean } = {}) {
  let room: RoomView | null = {
    id: 'r1',
    phase: 'lobby',
    ownerId: 'owner',
    members: [
      {
        userId: 'owner',
        username: 'Owner',
        status: 'ready',
        connected: true,
        inGame: false,
        loaded: false,
        partner: { dex: 4, shiny: false },
      },
      {
        userId: 'me',
        username: 'Me',
        status: initial,
        connected: true,
        inGame: false,
        loaded: false,
        partner: { dex: 7, shiny: false },
      },
    ],
    invited: [],
    maxMembers: 4,
    blockers: [],
    loadingDeadline: null,
  };
  const sent: MemberStatus[] = [];
  const queue: (() => void)[] = [];
  const me = () => room?.members.find((m) => m.userId === 'me');
  const busy: BusyStatus = new BusyStatus({
    room: () => room,
    selfId: () => 'me',
    setStatus: (status) => {
      sent.push(status);
      const apply = () => {
        const m = me();
        if (m) m.status = status;
        busy.onRoom();
      };
      if (opts.manual) queue.push(apply);
      else queueMicrotask(apply);
      return Promise.resolve();
    },
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    busy,
    sent,
    me,
    flush,
    deliver: () => queue.splice(0).forEach((f) => f()),
    setRoom: (fn: (r: RoomView | null) => RoomView | null) => {
      room = fn(room);
      busy.onRoom();
    },
  };
}

describe('BusyStatus', () => {
  it('goes busy on a busy screen and restores ready on return', async () => {
    const t = setup('ready');
    t.busy.setBusyScreen(true); // opens the gacha
    await t.flush();
    expect(t.me()?.status).toBe('busy');
    t.busy.setBusyScreen(false); // back to the lobby
    await t.flush();
    expect(t.me()?.status).toBe('ready');
    expect(t.sent).toEqual(['busy', 'ready']);
  });

  it('restores not-ready too', async () => {
    const t = setup('not-ready');
    t.busy.setBusyScreen(true);
    await t.flush();
    expect(t.me()?.status).toBe('busy');
    t.busy.setBusyScreen(false);
    await t.flush();
    expect(t.me()?.status).toBe('not-ready');
  });

  it('stays busy (one message) when moving between busy screens', async () => {
    const t = setup('ready');
    t.busy.setBusyScreen(true); // gacha
    await t.flush();
    t.busy.setBusyScreen(true); // shop
    t.busy.setBusyScreen(true); // collection
    await t.flush();
    expect(t.sent).toEqual(['busy']);
    t.busy.setBusyScreen(false);
    await t.flush();
    expect(t.me()?.status).toBe('ready');
  });

  it('does nothing outside a room', async () => {
    const t = setup('ready');
    t.setRoom(() => null);
    t.busy.setBusyScreen(true);
    t.busy.setBusyScreen(false);
    await t.flush();
    expect(t.sent).toEqual([]);
  });

  it('goes busy when joining a room while on a busy screen', async () => {
    const t = setup('not-ready');
    const saved: RoomView[] = [];
    t.setRoom((r) => {
      if (r) saved.push(r);
      return null;
    });
    t.busy.setBusyScreen(true);
    expect(t.sent).toEqual([]);
    t.setRoom(() => saved[0] ?? null);
    await t.flush();
    expect(t.me()?.status).toBe('busy');
  });

  it('re-asserts busy if the server resets the status (e.g. after a reconnect)', async () => {
    const t = setup('ready');
    t.busy.setBusyScreen(true);
    await t.flush();
    t.setRoom((r) => {
      const m = r?.members.find((x) => x.userId === 'me');
      if (m) m.status = 'not-ready';
      return r;
    });
    await t.flush();
    expect(t.me()?.status).toBe('busy');
    t.busy.setBusyScreen(false);
    await t.flush();
    // It restores what it saw last before going busy again.
    expect(t.me()?.status).toBe('not-ready');
  });

  it('handles a quick return before the server confirmed busy', () => {
    const t = setup('ready', { manual: true });
    t.busy.setBusyScreen(true);
    t.busy.setBusyScreen(false); // back before the reply
    t.deliver(); // server applies busy → client sends ready
    t.deliver();
    expect(t.me()?.status).toBe('ready');
    expect(t.sent).toEqual(['busy', 'ready']);
  });

  it('leaves the status alone while a game is loading or running', async () => {
    const t = setup('ready');
    t.setRoom((r) => (r ? { ...r, phase: 'running' } : r));
    t.busy.setBusyScreen(true);
    await t.flush();
    expect(t.sent).toEqual([]);
  });
});
