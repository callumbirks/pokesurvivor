import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Placeholder: auth (argon2id + session cookie) lands in phase 3. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
