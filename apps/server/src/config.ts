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
  /** Static sprite assets, served at /sprites/. */
  assetsDir: string;
  /** Mark the session cookie `Secure`. Defaults to on in production (served over TLS). */
  secureCookies: boolean;
  /** Daily and weekly leaderboards and missions reset at midnight in this IANA time zone. */
  leaderboardTimeZone: string;
  game: GameConfig;
  soloRuns: SoloRunConfig;
  rateLimits: {
    /** Per IP, for each of login and register. */
    auth: RateLimit;
    /** Per IP, for other endpoints that create rows (starting runs, friend requests). */
    actions: RateLimit;
  };
}

/** The WebSocket game server (rooms, the authoritative loop, reconnects, deploys). */
export interface GameConfig {
  /** Snapshots per second sent to each client. */
  snapshotHz: number;
  /** Coop choices (level-up cards, item swaps) resolve by themselves after this. */
  choiceTimeoutS: number;
  /** A disconnected player's slot is kept this long (idle, invulnerable) before they're removed. */
  reconnectGraceMs: number;
  /** Fresh reconnect window after restoring rooms on boot. */
  restartReconnectGraceMs: number;
  /** Members who haven't acked "loaded" by then are dropped from the game. */
  loadingTimeoutMs: number;
  inviteTtlMs: number;
  /** Clients ping this often; sockets silent for 5 of these are dropped. */
  heartbeatMs: number;
}

/** Solo runs (client-simulated): checkpoints and the timeout that credits them. */
export interface SoloRunConfig {
  /** A started run with no checkpoint or report for this long is credited from its last checkpoint. */
  checkpointTimeoutMs: number;
  /** How often the server looks for such runs (also once at start). */
  sweepIntervalMs: number;
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
    assetsDir: resolve(env.ASSETS_DIR ?? resolve(here, '../../../assets')),
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction,
    leaderboardTimeZone: timeZone(env.LEADERBOARD_TIME_ZONE),
    game: {
      snapshotHz: positiveInt('SNAPSHOT_HZ', env.SNAPSHOT_HZ, 20),
      choiceTimeoutS: positiveInt('CHOICE_TIMEOUT_S', env.CHOICE_TIMEOUT_S, 30),
      reconnectGraceMs: positiveInt('RECONNECT_GRACE_S', env.RECONNECT_GRACE_S, 60) * 1000,
      restartReconnectGraceMs:
        positiveInt('RESTART_RECONNECT_GRACE_S', env.RESTART_RECONNECT_GRACE_S, 180) * 1000,
      loadingTimeoutMs: positiveInt('LOADING_TIMEOUT_S', env.LOADING_TIMEOUT_S, 15) * 1000,
      inviteTtlMs: 120_000,
      heartbeatMs: 2000,
    },
    soloRuns: {
      checkpointTimeoutMs:
        positiveInt('RUN_CHECKPOINT_TIMEOUT_S', env.RUN_CHECKPOINT_TIMEOUT_S, 3600) * 1000,
      sweepIntervalMs: positiveInt('RUN_SWEEP_INTERVAL_S', env.RUN_SWEEP_INTERVAL_S, 60) * 1000,
    },
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
