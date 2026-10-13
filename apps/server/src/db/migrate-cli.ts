import { loadConfig } from '../config.js';
import { runMigrations } from './index.js';

const config = loadConfig();
await runMigrations(config.databaseUrl, config.migrationsDir);
console.log(`Migrations applied from ${config.migrationsDir}`);
