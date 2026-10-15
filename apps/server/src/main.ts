import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';

const config = loadConfig();
/**
 * Players get `updateWarningMs` of warning; saving games, handing over lobbies and closing
 * sockets and the database get the rest. Keep the stop grace period above this (docs/deploy.md).
 */
const SHUTDOWN_TIMEOUT_MS = config.game.updateWarningMs + 20_000;

if (config.migrateOnStart) await runMigrations(config.databaseUrl, config.migrationsDir);

const db = createDb(config.databaseUrl);
const app = await buildApp({ config, db });
app.addHook('onClose', async () => {
  await db.close();
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    // No new rooms or games; players see a countdown, then running coop games are saved for the
    // next server and lobbies handed over (clients reconnect by themselves). Ctrl-C in
    // development skips the countdown.
    await app.game?.shutdown(signal === 'SIGINT' ? 0 : config.game.updateWarningMs);
    // Stops accepting connections, closes open WebSockets, then runs onClose hooks (database).
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

await app.listen({ host: config.host, port: config.port });
