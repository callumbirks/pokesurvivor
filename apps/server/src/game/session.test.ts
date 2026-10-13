import { CloseCode, PROTOCOL_VERSION, encode } from '@pokesurvivor/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createGameTestServer,
  lobby,
  makeFriends,
  sleep,
  waitFor,
  withTimeout,
} from '../test/bots.js';
import type { GameTestServer } from '../test/bots.js';

/** A raw socket (no NetClient) and the messages it got, for protocol-level checks. */
function raw(url: string, cookie?: string) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary)
      messages.push(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const opened = new Promise<void>((resolve) => ws.on('open', () => resolve()));
  return { ws, messages, closed, opened };
}

describe('game sessions', () => {
  let t: GameTestServer;
  beforeAll(async () => {
    t = await createGameTestServer();
  });
  afterAll(() => t.close());

  it('rejects anonymous connections', async () => {
    const s = raw(t.url);
    const { code } = await withTimeout(s.closed, 5000, 'close');
    expect(code).toBe(CloseCode.unauthenticated);
    expect(s.messages[0]).toMatchObject({ type: 'error', error: { code: 'unauthenticated' } });
  });

  it('closes on a protocol version mismatch', async () => {
    const b = await t.bot();
    const s = raw(t.url, b.cookie);
    await s.opened;
    s.ws.send(encode({ type: 'hello', protocolVersion: PROTOCOL_VERSION + 1 }));
    expect((await withTimeout(s.closed, 5000, 'close')).code).toBe(CloseCode.versionMismatch);
    expect(s.messages[0]).toMatchObject({ error: { code: 'version_mismatch' } });
  });

  it('welcomes, answers pings and measures RTT', async () => {
    const b = await t.bot({ latencyMs: 20 });
    await b.connect();
    expect(b.client.user?.username).toBe(b.username);
    await waitFor(() => b.client.rttMs !== null, 'an RTT');
    expect(b.client.rttMs).toBeGreaterThanOrEqual(40);
  });

  it('supersedes the older socket of the same user, which does not reconnect', async () => {
    const b = await t.bot();
    await b.connect();
    const s = raw(t.url, b.cookie);
    await s.opened;
    s.ws.send(encode({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    await waitFor(() => b.client.state === 'failed', 'the first client to give up');
    expect(b.client.failure?.code).toBe(CloseCode.superseded);
    await waitFor(() => s.messages.find((m) => m.type === 'welcome'), 'welcome');
    await sleep(300);
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
    s.ws.close();
  });

  it('answers malformed requests with bad_request and closes after too many', async () => {
    const b = await t.bot();
    const s = raw(t.url, b.cookie);
    await s.opened;
    s.ws.send(encode({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    s.ws.send(encode({ type: 'room.status', rid: 5, status: 'sleeping' }));
    await waitFor(() => s.messages.find((m) => m.type === 'reply'), 'a reply');
    expect(s.messages.find((m) => m.type === 'reply')).toMatchObject({
      rid: 5,
      ok: false,
      error: { code: 'bad_request' },
    });
    for (let i = 0; i < 25; i++) s.ws.send('nonsense');
    expect((await withTimeout(s.closed, 5000, 'close')).code).toBe(CloseCode.protocolError);
  });

  it('refuses oversized messages and rate-limits floods', async () => {
    const b = await t.bot();
    const big = raw(t.url, b.cookie);
    await big.opened;
    big.ws.send('x'.repeat(10_000));
    expect((await withTimeout(big.closed, 5000, 'close')).code).toBe(1009);

    const flood = raw(t.url, b.cookie);
    await flood.opened;
    flood.ws.send(encode({ type: 'hello', protocolVersion: PROTOCOL_VERSION }));
    for (let i = 0; i < 600; i++)
      flood.ws.send(encode({ type: 'input', gameId: 'none', seq: i + 1, moveX: 0, moveY: 0 }));
    expect((await withTimeout(flood.closed, 5000, 'close')).code).toBe(CloseCode.rateLimited);
  });

  it('pushes presence and friend changes to online friends', async () => {
    const [ash, misty] = await t.party(2);
    const presence = () => ash!.client.friends.get(misty!.username);
    await waitFor(() => presence() === 'online', 'misty online');
    await misty!.client.createRoom();
    await waitFor(() => presence() === 'in_lobby', 'misty in a lobby');
    misty!.client.close();
    await waitFor(() => presence() === 'offline', 'misty offline');

    // A friend request accepted over HTTP shows up live on the requester's socket.
    const brock = await t.bot();
    await brock.connect();
    const friendEvent = brock.client.next('friend');
    await t.app.inject({
      method: 'POST',
      url: '/api/friends/requests',
      headers: { cookie: brock.cookie },
      payload: { username: ash!.username },
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/friends/requests/${brock.username}/accept`,
      headers: { cookie: ash!.cookie },
    });
    expect(await withTimeout(friendEvent, 5000, 'brock notified')).toEqual({
      event: 'request_accepted',
      username: ash!.username,
    });
    // Both see each other's presence straight away.
    await waitFor(
      () => brock.client.friends.get(ash!.username) === 'online',
      'ash online for brock',
    );
    await waitFor(
      () => ash!.client.friends.get(brock.username) === 'online',
      'brock online for ash',
    );
  });
});

describe('lobbies', () => {
  let t: GameTestServer;
  beforeAll(async () => {
    t = await createGameTestServer();
  });
  afterAll(() => t.close());

  it('invites online friends only, and accepts, declines and joins', async () => {
    const [owner, friend, other] = await t.party(3);
    const stranger = await t.bot();
    await stranger.connect();
    const room = await owner!.client.createRoom();
    await expect(owner!.client.invite(stranger.username)).rejects.toMatchObject({
      code: 'not_friends',
    });
    other!.client.close();
    await waitFor(() => !t.game.isOnline(other!.userId), 'other offline');
    await expect(owner!.client.invite(other!.username)).rejects.toMatchObject({
      code: 'not_online',
    });
    await expect(stranger.client.join(room.id)).rejects.toMatchObject({ code: 'no_invite' });

    const invite = friend!.client.next('invite');
    await owner!.client.invite(friend!.username);
    expect(await invite).toMatchObject({ roomId: room.id, from: owner!.username });
    const declined = owner!.client.next('invite.declined');
    await friend!.client.declineInvite(room.id);
    expect(await declined).toMatchObject({ username: friend!.username });
    await expect(friend!.client.join(room.id)).rejects.toMatchObject({ code: 'no_invite' });

    await owner!.client.invite(friend!.username);
    const view = await friend!.client.join(room.id);
    expect(view.members.map((m) => m.username)).toEqual([owner!.username, friend!.username]);
    await waitFor(() => owner!.client.roomView?.members.length === 2, 'owner sees the guest');
  });

  it('holds at most 4 members', async () => {
    const bots = await t.party(5);
    await lobby(bots.slice(0, 4));
    await expect(bots[0]!.client.invite(bots[4]!.username)).rejects.toMatchObject({
      code: 'room_full',
    });
  });

  it('blocks the start while a member is busy (the gacha bug)', async () => {
    const bots = await t.party(2);
    await lobby(bots);
    const [owner, guest] = bots;
    // The guest opens the gacha: the owner can't start without them.
    await guest!.client.setStatus('busy');
    await waitFor(
      () => owner!.client.roomView?.blockers.includes(guest!.username),
      'blocker shown',
    );
    await expect(owner!.client.start()).rejects.toMatchObject({ code: 'not_ready' });
    expect(t.game.roomOfUser(owner!.userId)?.phase).toBe('lobby');
    // Not-ready blocks too; only the owner may start.
    await guest!.client.setStatus('not-ready');
    await expect(owner!.client.start()).rejects.toMatchObject({ code: 'not_ready' });
    await guest!.client.setStatus('ready');
    await expect(guest!.client.start()).rejects.toMatchObject({ code: 'not_owner' });
    await waitFor(() => owner!.client.roomView?.blockers.length === 0, 'no blockers');
    const loading = guest!.client.next('loading');
    await owner!.client.start();
    expect((await loading).game.players.map((p) => p.id).sort()).toEqual(
      [owner!.userId, guest!.userId].sort(),
    );
  });

  it('passes ownership on when the owner leaves, and closes empty rooms', async () => {
    const bots = await t.party(3);
    const roomId = await lobby(bots);
    const notice = bots[1]!.client.next('notice', (n) => n.code === 'owner-changed');
    await bots[0]!.client.leaveRoom();
    expect((await notice).usernames).toEqual([bots[1]!.username]);
    await waitFor(() => bots[2]!.client.roomView?.ownerId === bots[1]!.userId, 'new owner');
    expect(bots[0]!.client.roomView).toBeNull();
    await bots[1]!.client.leaveRoom();
    await bots[2]!.client.leaveRoom();
    expect(t.game.liveRooms.has(roomId)).toBe(false);
  });

  it('keeps a lobby member for the reconnect grace, then removes them', async () => {
    const t2 = await createGameTestServer({ reconnectGraceMs: 400 });
    try {
      const [owner, guest] = await t2.party(2);
      await lobby([owner!, guest!]);
      guest!.drop({ offlineMs: 2000 });
      await waitFor(
        () =>
          owner!.client.roomView?.members.find((m) => m.userId === guest!.userId)?.connected ===
          false,
        'guest shown disconnected',
      );
      expect(owner!.client.roomView?.blockers).toContain(guest!.username);
      await waitFor(() => owner!.client.roomView?.members.length === 1, 'guest removed');
    } finally {
      await t2.close();
    }
  });

  it('lets friends sit in the lobby: makeFriends is symmetric', async () => {
    const a = await t.bot();
    const b = await t.bot();
    await makeFriends(t.database, [a, b]);
    await a.connect();
    await b.connect();
    await waitFor(() => a.client.friends.get(b.username) === 'online', 'b online for a');
  });

  it('refuses to start a solo run while the player is in a room', async () => {
    const b = await t.bot();
    await b.connect();
    const start = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/runs/start',
        headers: { cookie: b.cookie },
        payload: { pokemon: { dex: 25, shiny: false } },
      });
    await b.client.createRoom();
    const refused = await start();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'in_room' } });
    await b.client.leaveRoom();
    expect((await start()).statusCode).toBe(201);
  });
});
