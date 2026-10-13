import { resolve } from 'node:path';

/** Directory of the running code: `src/` under tsx, `dist/` once bundled. Both sit one level below the app. */
const here = import.meta.dirname;

const DEV_DATABASE_URL = 'postgres://pokesurvivor:pokesurvivor@localhost:5432/pokesurvivor';

export interface Config {
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  migrateOnStart: boolean;
  migrationsDir: string;
  /** Built client (Vite output). Not served if it doesn't exist, e.g. in dev where Vite serves it. */
  clientDir: string;
  /** The legacy game, served under /legacy/ for side-by-side comparison. */
  legacyDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL ?? (isProduction ? undefined : DEV_DATABASE_URL);
  if (!databaseUrl) throw new Error('DATABASE_URL is required in production');

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid PORT: ${env.PORT}`);

  return {
    isProduction,
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl,
    migrateOnStart: env.MIGRATE_ON_START !== 'false',
    migrationsDir: resolve(here, '../drizzle'),
    clientDir: resolve(env.CLIENT_DIR ?? resolve(here, '../../client/dist')),
    legacyDir: resolve(env.LEGACY_DIR ?? resolve(here, '../../../legacy')),
  };
}
