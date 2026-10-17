// Re-credits co-op runs whose recording failed, from the server's JSON log lines (a file, or
// stdin): `node apps/server/dist/recredit.js [--apply] [lines.json] < lines.json`. A dry run
// unless `--apply`. See docs/deploy.md ("Re-crediting failed co-op runs").
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { formatResults, parseFailedRecordings, recreditGames } from './runs/recredit.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const unknown = args.filter((a) => a.startsWith('--') && a !== '--apply');
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(' ')}. Usage: recredit.js [--apply] [file]`);
  process.exit(2);
}
const file = args.find((a) => !a.startsWith('--'));
const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');

const parsed = parseFailedRecordings(text);
const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const results = await recreditGames(db.db, parsed.games, {
    apply,
    timeZone: config.leaderboardTimeZone,
    log: { warn: (obj: object, msg?: string) => console.error(msg, JSON.stringify(obj)) },
  });
  console.log(formatResults(parsed, results, apply));
} finally {
  await db.close();
}
