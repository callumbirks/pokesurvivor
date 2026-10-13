import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db,
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    close: () => client.end({ timeout: 5 }),
  };
}

export type Db = ReturnType<typeof createDb>;
/** The Drizzle handle the services use. */
export type Database = Db['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either the database or an open transaction (services can run inside a caller's transaction). */
export type Executor = Database | Transaction;

/** Applies pending migrations from `migrationsDir` on a dedicated single connection. */
export async function runMigrations(databaseUrl: string, migrationsDir: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
  } finally {
    await client.end({ timeout: 5 });
  }
}
