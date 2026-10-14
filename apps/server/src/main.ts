import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';

const config = loadConfig();
/** Running games get `drainTimeoutMs`; closing sockets and the database gets the rest. */
const SHUTDOWN_TIMEOUT_MS = config.game.drainTimeoutMs + 15_000;

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
    // No new rooms or games; running games may finish (players see "server updating"), then
    // they're ended and credited. Lobby clients are sent to reconnect (to the new instance).
    // Ctrl-C in development ends games at once (still credited).
    await app.game?.drain(signal === 'SIGINT' ? 0 : config.game.drainTimeoutMs);
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
