import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { isUniqueViolation } from '../db/errors.js';
import { users } from '../db/schema.js';
import { ApiError, parseBody } from '../http/errors.js';
import { createSave } from '../saves/service.js';
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.js';
import { clearSessionCookie, createAuthHooks, currentUser, setSessionCookie } from './plugin.js';
import { SESSION_COOKIE, createSession, deleteSession } from './sessions.js';
import {
  assertUsernameAllowed,
  findUserByUsername,
  passwordSchema,
  usernameSchema,
} from './users.js';

export interface AuthRoutesOptions {
  db: Database;
  secureCookies: boolean;
  startingCoins: number;
  rateLimit: { max: number; timeWindowMs: number };
}

const registerBody = z.object({ username: usernameSchema, password: passwordSchema });
// Login doesn't re-check the username rules: an invalid name just isn't found.
const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

export function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): void {
  const { db, secureCookies } = opts;
  const { requireUser } = createAuthHooks({ db, secureCookies });
  const rateLimit = { max: opts.rateLimit.max, timeWindow: opts.rateLimit.timeWindowMs };

  async function startSession(
    reply: Parameters<typeof setSessionCookie>[0],
    userId: string,
  ): Promise<void> {
    const { token, expiresAt } = await createSession(db, userId);
    setSessionCookie(reply, token, expiresAt, secureCookies);
  }

  app.post('/api/auth/register', { config: { rateLimit } }, async (request, reply) => {
    const { username, password } = parseBody(registerBody, request.body);
    assertUsernameAllowed(username);
    const passwordHash = await hashPassword(password);
    let userId: string;
    try {
      userId = await db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ username, passwordHash })
          .returning({ id: users.id });
        if (!user) throw new Error('insert returned no row');
        await createSave(tx, user.id, opts.startingCoins);
        return user.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, 'username_taken', 'Username is taken');
      throw err;
    }
    await startSession(reply, userId);
    return reply.status(201).send({ user: { id: userId, username, isAdmin: false } });
  });

  app.post('/api/auth/login', { config: { rateLimit } }, async (request, reply) => {
    const { username, password } = parseBody(loginBody, request.body);
    const user = await findUserByUsername(db, username);
    const ok = user
      ? await verifyPassword(user.passwordHash, password)
      : await verifyDummyPassword(password);
    if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Wrong username or password');
    await startSession(reply, user.id);
    return { user: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    clearSessionCookie(reply, secureCookies);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser }, (request) => ({
    user: currentUser(request),
  }));
}
