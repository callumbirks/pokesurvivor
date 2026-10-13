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
  /** Mark the session cookie `Secure`. Defaults to on in production (served over TLS). */
  secureCookies: boolean;
  /** Daily and weekly leaderboards reset at midnight in this IANA time zone. */
  leaderboardTimeZone: string;
  rateLimits: {
    /** Per IP, for each of login and register. */
    auth: RateLimit;
    /** Per IP, for other endpoints that create rows (starting runs, friend requests). */
    actions: RateLimit;
  };
}

export interface RateLimit {
  max: number;
  timeWindowMs: number;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

function timeZone(value: string | undefined): string {
  const zone = value || 'Europe/Madrid';
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
  } catch {
    throw new Error(`Invalid LEADERBOARD_TIME_ZONE: ${zone}`);
  }
  return zone;
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
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction,
    leaderboardTimeZone: timeZone(env.LEADERBOARD_TIME_ZONE),
    rateLimits: {
      auth: {
        max: positiveInt('AUTH_RATE_LIMIT_MAX', env.AUTH_RATE_LIMIT_MAX, 10),
        timeWindowMs: 60_000,
      },
      actions: {
        max: positiveInt('ACTION_RATE_LIMIT_MAX', env.ACTION_RATE_LIMIT_MAX, 60),
        timeWindowMs: 60_000,
      },
    },
  };
}
