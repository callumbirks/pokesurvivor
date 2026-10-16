import type { IncomingMessage } from 'node:http';
import fastifyCookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Executor } from '../db/index.js';
import { ApiError } from '../http/errors.js';
import { SESSION_COOKIE, resolveSession } from './sessions.js';
import type { SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `requireUser` / `optionalUser` hooks. */
    user: SessionUser | null;
  }
}

export interface AuthOptions {
  db: Executor;
  /** Send the cookie with `Secure` (production, behind TLS). */
  secureCookies: boolean;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}

/**
 * Resolves the logged-in user from a raw `Cookie` header. This is what the WebSocket game server
 * uses on upgrade (`authenticateUpgrade`); HTTP routes use the hooks below.
 */
export async function userFromCookieHeader(
  db: Executor,
  cookieHeader: string | undefined,
): Promise<SessionUser | null> {
  if (!cookieHeader) return null;
  const token = fastifyCookie.parse(cookieHeader)[SESSION_COOKIE];
  return (await resolveSession(db, token))?.user ?? null;
}

/**
 * For the WebSocket server: the user behind an upgrade request (a Fastify request on a
 * `{ websocket: true }` route, or a raw `IncomingMessage` from `ws`), or null if not logged in.
 * Reject the upgrade when it returns null. Browsers send cookies on same-origin WebSocket
 * upgrades, so the client needs no extra token.
 */
export function authenticateUpgrade(
  db: Executor,
  request: FastifyRequest | IncomingMessage,
): Promise<SessionUser | null> {
  return userFromCookieHeader(db, request.headers.cookie);
}

export interface AuthHooks {
  /** preHandler: 401 `unauthenticated` unless logged in; sets `request.user`. */
  requireUser: preHandlerAsyncHookHandler;
  /** preHandler: sets `request.user` if logged in, null otherwise. */
  optionalUser: preHandlerAsyncHookHandler;
  /**
   * preHandler for every admin endpoint: 401 `unauthenticated` unless logged in, and 404
   * `not_found` unless an admin (`users.is_admin`), so the admin API looks like it isn't there.
   */
  requireAdmin: preHandlerAsyncHookHandler;
}

export function createAuthHooks({ db, secureCookies }: AuthOptions): AuthHooks {
  async function load(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    const session = await resolveSession(db, token);
    request.user = session?.user ?? null;
    if (session?.renewed && token) setSessionCookie(reply, token, session.expiresAt, secureCookies);
  }
  return {
    async requireUser(request, reply) {
      await load(request, reply);
      if (!request.user) throw new ApiError(401, 'unauthenticated', 'Not logged in');
    },
    async optionalUser(request, reply) {
      await load(request, reply);
    },
    async requireAdmin(request, reply) {
      await load(request, reply);
      if (!request.user) throw new ApiError(401, 'unauthenticated', 'Not logged in');
      if (!request.user.isAdmin) throw new ApiError(404, 'not_found', 'Not found');
    },
  };
}

/** The user set by `requireUser`. Throws if the route forgot the hook. */
export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new ApiError(401, 'unauthenticated', 'Not logged in');
  return request.user;
}
