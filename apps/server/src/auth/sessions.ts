import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Executor } from '../db/index.js';
import { sessions, users } from '../db/schema.js';

export const SESSION_COOKIE = 'ps_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sessions used after this much of their lifetime has passed get extended to a full TTL. */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  username: string;
  /** Can use the admin endpoints (`users.is_admin`). */
  isAdmin: boolean;
}

export interface ResolvedSession {
  user: SessionUser;
  expiresAt: Date;
  /** True if the expiry was just extended, so the cookie should be re-sent. */
  renewed: boolean;
}

/** Only the hash is stored, so a leaked sessions table can't be used to log in. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Executor,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  // Opportunistic cleanup of this user's expired sessions.
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, sql`now()`)));
  return { token, expiresAt };
}

/** Looks up a session token (from the cookie), extending it if it's due for renewal. */
export async function resolveSession(
  db: Executor,
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token || token.length > 128) return null;
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)));
  if (!row) return null;

  const user = { id: row.id, username: row.username, isAdmin: row.isAdmin };
  if (row.expiresAt.getTime() - Date.now() > SESSION_TTL_MS - RENEW_AFTER_MS)
    return { user, expiresAt: row.expiresAt, renewed: false };
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash));
  return { user, expiresAt, renewed: true };
}

export async function deleteSession(db: Executor, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
