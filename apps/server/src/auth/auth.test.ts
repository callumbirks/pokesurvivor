import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ECONOMY } from '../economy/config.js';
import { createTestApp, uniqueUsername } from '../test/harness.js';
import type { TestApp } from '../test/harness.js';
import { authenticateUpgrade, userFromCookieHeader } from './plugin.js';

describe('auth', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('registers, reports the user and sets an httpOnly session cookie', async () => {
    const c = t.client();
    const username = uniqueUsername('Ash');
    const res = await c.post('/api/auth/register', { username, password: 'pikachu123' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ user: { username } });
    const cookie = res.cookies.find((x) => x.name === 'ps_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.secure).toBeFalsy();

    const me = await c.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username } });
  });

  it('creates a save with the starting coins recorded in the ledger', async () => {
    const c = await t.newUser();
    const save = await c.get('/api/save');
    const startingCoins = DEFAULT_ECONOMY.startingCoins;
    expect(save.json()).toMatchObject({ coins: startingCoins, tickets: { x1: 0, x10: 0 } });
    const ledger = await t.db.db.query.currencyLedger.findMany({
      where: (l, { eq }) => eq(l.userId, c.userId),
    });
    expect(ledger).toMatchObject(
      startingCoins > 0
        ? [
            {
              currency: 'coins',
              delta: startingCoins,
              balanceAfter: startingCoins,
              reason: 'starting_grant',
            },
          ]
        : [],
    );
  });

  it('rejects usernames that break the rules', async () => {
    const c = t.client();
    for (const username of ['ab', 'a'.repeat(17), 'with space', 'émile', 'semi;colon']) {
      const res = await c.post('/api/auth/register', { username, password: 'pikachu123' });
      expect(res.statusCode, username).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });

  it('rejects short passwords and malformed bodies', async () => {
    const c = t.client();
    const short = await c.post('/api/auth/register', { username: uniqueUsername(), password: 'x' });
    expect(short.statusCode).toBe(400);
    const missing = await c.post('/api/auth/register', { username: uniqueUsername() });
    expect(missing.statusCode).toBe(400);
  });

  it('treats usernames as unique ignoring case', async () => {
    const username = uniqueUsername('Misty');
    await t.newUser(username);
    const res = await t
      .client()
      .post('/api/auth/register', { username: username.toUpperCase(), password: 'pikachu123' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'username_taken' } });
  });

  it('logs in case-insensitively and rejects wrong credentials', async () => {
    const user = await t.newUser(uniqueUsername('Brock'));
    const c = t.client();
    const wrong = await c.post('/api/auth/login', { username: user.username, password: 'nope' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'invalid_credentials' } });
    const unknown = await c.post('/api/auth/login', { username: 'nobody_here', password: 'x' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ error: { code: 'invalid_credentials' } });

    const ok = await c.post('/api/auth/login', {
      username: user.username.toLowerCase(),
      password: 'correct horse',
    });
    expect(ok.statusCode).toBe(200);
    // The stored spelling is returned, not the one typed.
    expect(ok.json()).toMatchObject({ user: { username: user.username } });
    expect((await c.get('/api/auth/me')).statusCode).toBe(200);
  });

  it('logs out, invalidating the session server-side', async () => {
    const c = await t.newUser();
    const stolenCookie = c.cookie;
    const res = await c.post('/api/auth/logout');
    expect(res.statusCode).toBe(204);
    expect(c.cookie).toBeUndefined();
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
    // Replaying the old cookie doesn't work either.
    c.cookie = stolenCookie;
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('requires a valid session on protected endpoints', async () => {
    const c = t.client();
    for (const url of ['/api/auth/me', '/api/save', '/api/friends']) {
      const res = await c.get(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    }
    c.cookie = 'ps_session=forged-token';
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('resolves the user from a cookie header, for WebSocket upgrades', async () => {
    const user = await t.newUser();
    const db = t.db.db;
    expect(await userFromCookieHeader(db, `other=1; ${user.cookie}`)).toEqual({
      id: user.userId,
      username: user.username,
    });
    expect(await userFromCookieHeader(db, undefined)).toBeNull();
    expect(await userFromCookieHeader(db, 'ps_session=nope')).toBeNull();
    const fakeUpgrade = { headers: { cookie: user.cookie } } as Parameters<
      typeof authenticateUpgrade
    >[1];
    expect(await authenticateUpgrade(db, fakeUpgrade)).toMatchObject({ id: user.userId });
  });
});

describe('auth rate limits', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { AUTH_RATE_LIMIT_MAX: '3' } });
  });
  afterAll(() => t.close());

  it('limits login attempts per IP', async () => {
    const c = t.client();
    const attempt = () => c.post('/api/auth/login', { username: 'someone', password: 'guess' });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('limits registrations per IP', async () => {
    const c = t.client();
    const attempt = () =>
      c.post('/api/auth/register', { username: uniqueUsername(), password: 'pikachu123' });
    for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(201);
    expect((await attempt()).statusCode).toBe(429);
  });

  it('counts each IP separately', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.9',
      payload: { username: 'someone', password: 'guess' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('secure cookies', () => {
  it('marks the cookie Secure when configured (production default)', async () => {
    const t = await createTestApp({ env: { COOKIE_SECURE: 'true' } });
    try {
      const res = await t
        .client()
        .post('/api/auth/register', { username: uniqueUsername(), password: 'pikachu123' });
      expect(res.cookies.find((x) => x.name === 'ps_session')?.secure).toBe(true);
    } finally {
      await t.close();
    }
  });
});
