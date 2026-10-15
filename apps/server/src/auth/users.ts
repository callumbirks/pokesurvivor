import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../db/index.js';
import { users } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { isOffensiveUsername } from './profanity.js';

/** Usernames are also the public nickname: 3–16 of `[A-Za-z0-9_]`, unique ignoring case. */
export const usernameSchema = z
  .string()
  .min(3)
  .max(16)
  .regex(/^[A-Za-z0-9_]+$/);

/**
 * Rejects offensive usernames (400 `username_not_allowed`). Every path that sets a username calls
 * this after `usernameSchema`; the error never says which word matched.
 */
export function assertUsernameAllowed(username: string): void {
  if (isOffensiveUsername(username)) {
    throw new ApiError(400, 'username_not_allowed', 'Username is not allowed');
  }
}

export const passwordSchema = z.string().min(8).max(128);

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
}

export async function findUserByUsername(
  db: Executor,
  username: string,
): Promise<UserRow | undefined> {
  const [row] = await db
    .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`);
  return row;
}
