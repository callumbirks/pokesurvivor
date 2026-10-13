import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, grantPokemon } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';
import type { FriendEvent, PresenceStatus } from './presence.js';

describe('friends', () => {
  let t: TestApp;
  const events: FriendEvent[] = [];
  const online = new Map<string, PresenceStatus>();

  beforeAll(async () => {
    t = await createTestApp({
      presence: {
        statusOf: (ids) =>
          new Map(ids.flatMap((id) => (online.has(id) ? [[id, online.get(id)!]] : []))),
      },
      friendNotifier: { notify: (event) => events.push(event) },
    });
  });
  afterAll(() => t.close());

  type List = {
    friends: { username: string; presence: string; partner: unknown; since: string }[];
    incoming: { username: string }[];
    outgoing: { username: string }[];
  };
  const list = async (c: { get(url: string): Promise<{ json<T>(): T }> }) =>
    (await c.get('/api/friends')).json<List>();

  it('sends, lists and accepts a request', async () => {
    const ash = await t.newUser();
    const misty = await t.newUser();
    await grantPokemon(t.db, misty.userId, [{ dex: 120 }]);
    await misty.put('/api/save/partner', { dex: 120 });

    // Usernames are matched ignoring case.
    const sent = await ash.post('/api/friends/requests', {
      username: misty.username.toUpperCase(),
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toEqual({ status: 'pending' });
    expect(events.at(-1)).toEqual({
      type: 'request_received',
      userId: misty.userId,
      fromUserId: ash.userId,
    });

    expect(await list(ash)).toMatchObject({
      friends: [],
      incoming: [],
      outgoing: [{ username: misty.username }],
    });
    expect(await list(misty)).toMatchObject({
      friends: [],
      incoming: [{ username: ash.username }],
      outgoing: [],
    });

    const again = await ash.post('/api/friends/requests', { username: misty.username });
    expect(again.json()).toMatchObject({ error: { code: 'request_already_sent' } });
    // Only the addressee can accept.
    expect((await ash.post(`/api/friends/requests/${misty.username}/accept`)).statusCode).toBe(404);

    const accepted = await misty.post(`/api/friends/requests/${ash.username}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(events.at(-1)).toEqual({
      type: 'request_accepted',
      userId: ash.userId,
      byUserId: misty.userId,
    });

    online.set(misty.userId, 'in_game');
    const ashList = await list(ash);
    expect(ashList).toMatchObject({
      friends: [
        { username: misty.username, presence: 'in_game', partner: { dex: 120, shiny: false } },
      ],
      incoming: [],
      outgoing: [],
    });
    expect((await list(misty)).friends).toMatchObject([
      { username: ash.username, presence: 'offline' },
    ]);

    const dup = await misty.post('/api/friends/requests', { username: ash.username });
    expect(dup.json()).toMatchObject({ error: { code: 'already_friends' } });
  });

  it('accepts automatically when both users send a request', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    await a.post('/api/friends/requests', { username: b.username });
    const res = await b.post('/api/friends/requests', { username: a.username });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect((await list(a)).friends).toHaveLength(1);
  });

  it('declines a request', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    await a.post('/api/friends/requests', { username: b.username });
    expect((await b.post(`/api/friends/requests/${a.username}/decline`)).statusCode).toBe(204);
    expect(await list(a)).toMatchObject({ friends: [], outgoing: [] });
    expect((await b.post(`/api/friends/requests/${a.username}/decline`)).statusCode).toBe(404);
    // A declined request can be sent again.
    expect((await a.post('/api/friends/requests', { username: b.username })).statusCode).toBe(201);
  });

  it('removes a friend or cancels an outgoing request, but not an incoming one', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const c = await t.newUser();
    await a.post('/api/friends/requests', { username: b.username });
    await b.post(`/api/friends/requests/${a.username}/accept`);
    await a.post('/api/friends/requests', { username: c.username });

    expect((await c.delete(`/api/friends/${a.username}`)).statusCode).toBe(404);
    expect((await a.delete(`/api/friends/${c.username}`)).statusCode).toBe(204);
    expect((await list(c)).incoming).toEqual([]);

    expect((await b.delete(`/api/friends/${a.username}`)).statusCode).toBe(204);
    expect(events.at(-1)).toEqual({ type: 'friend_removed', userId: a.userId, byUserId: b.userId });
    expect((await list(a)).friends).toEqual([]);
    expect((await b.delete(`/api/friends/${a.username}`)).statusCode).toBe(404);
  });

  it('rejects unknown users, yourself and anonymous requests', async () => {
    const a = await t.newUser();
    const unknown = await a.post('/api/friends/requests', { username: 'no_such_user' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'user_not_found' } });
    const self = await a.post('/api/friends/requests', { username: a.username });
    expect(self.json()).toMatchObject({ error: { code: 'cannot_friend_self' } });
    expect(
      (await t.client().post('/api/friends/requests', { username: a.username })).statusCode,
    ).toBe(401);
    expect((await a.post('/api/friends/requests', {})).statusCode).toBe(400);
  });
});
