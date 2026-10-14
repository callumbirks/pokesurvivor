import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';

const config = loadConfig();
/** Room checkpoint, socket/HTTP close and database pool close must fit inside Docker grace. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

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
    // Freeze and persist rooms before any socket closes; SIGINT follows the same path.
    await app.game?.shutdown();
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
