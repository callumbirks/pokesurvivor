// Live tuning on the client: which game data the screens read. In a run, the run's own config
// (what the server issued it, `Game.config`), so the HUD, the stats, card texts and prediction
// match the sim; outside a run, the published config (`GET /api/config`), for numbers the menus
// show (the Momentum help, prestige). The built-in data until either is known.
import { gameDataForRun, loadGameData, type GameData } from '@pokesurvivor/data';
import type { RunConfigWire } from '@pokesurvivor/protocol';

let published: GameData | null = null;
let run: GameData | null = null;
/** Configs built lately, by their JSON (each is built once, and the sim's caches follow it). */
const built = new Map<string, GameData>();
const KEEP = 4;

function build(cfg: RunConfigWire): GameData {
  const key = JSON.stringify(cfg);
  const hit = built.get(key);
  if (hit) return hit;
  const { game, skipped } = gameDataForRun(loadGameData(), cfg);
  // A config from a server running another build: its defaults apply where it doesn't fit.
  if (skipped.length) console.warn('[config] settings this client skips:', skipped);
  built.set(key, game);
  for (const k of built.keys()) if (built.size > KEEP) built.delete(k);
  return game;
}

/** The game data screens read now: the run's, else the published one, else the built-in. */
export function gameData(): GameData {
  return run ?? published ?? loadGameData();
}

/** A run starts (or resumes) with this config (none: the built-in data). */
export function setRunConfig(cfg: RunConfigWire | null | undefined): GameData {
  run = cfg ? build(cfg) : loadGameData();
  return run;
}

/** The run is over: the menus' numbers come from the published config again. */
export function clearRunConfig(): void {
  run = null;
}

/** The published config (from `GET /api/config`). */
export function setPublishedConfig(cfg: RunConfigWire | null): void {
  published = cfg ? build(cfg) : null;
}

/** The built game data of a config (the solo worker, tests). */
export function gameDataOf(cfg: RunConfigWire | null | undefined): GameData {
  return cfg ? build(cfg) : loadGameData();
}
