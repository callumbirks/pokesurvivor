// Live tuning: `tuning.json` and `levelup.json` with overrides on top (an admin publishes them on
// the server without a deploy). Overrides are a deep-merge patch per file: objects merge key by
// key, anything else (numbers, strings, arrays) replaces the default. They are validated with the
// files' own zod schemas plus the cross-file checks `loadGameData` makes.
import type { z } from 'zod';
import type { GameData } from './index.js';
import { LevelUpFileSchema, TuningFileSchema } from './schemas/index.js';
import type { LevelUpFile, TuningFile } from './schemas/index.js';
import { indexBy } from './util.js';

/** The data files live tuning can change, by key (the file name without `.json`). */
export const TUNABLE_FILES = ['tuning', 'levelup'] as const;
export type TunableFile = (typeof TUNABLE_FILES)[number];

/** The effective contents of the tunable files. */
export interface TunableConfig {
  tuning: TuningFile;
  levelup: LevelUpFile;
}

export type JsonObject = { [key: string]: unknown };

/** Overrides: a deep-merge patch per tunable file (absent: that file's defaults). */
export type ConfigOverrides = Partial<Record<TunableFile, JsonObject>>;

/** A run's config as the server issues it: the config version and the effective files. */
export interface RunConfig {
  /** The config version (0: the built-in defaults). */
  version: number;
  tuning: TuningFile;
  levelup: LevelUpFile;
}

/** One problem with a config: the file, the path in it (`spawner.cap`) and what's wrong. */
export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

export const isJsonObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// JSON data only (no DOM or Node types in this package for `structuredClone`).
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** `base` with `patch` merged in: objects key by key, everything else replaced. Copies. */
export function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isJsonObject(patch) || !isJsonObject(base)) return clone(patch);
  const out: JsonObject = clone(base);
  for (const [k, v] of Object.entries(patch)) out[k] = k in out ? mergePatch(out[k], v) : clone(v);
  return out;
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The smallest patch that turns `base` into `target` (`mergePatch(base, patch)` equals it), or
 * undefined if they're equal. Keys only in `base` can't be removed by a patch and are ignored
 * (the schemas reject a missing key anyway).
 */
export function diffPatch(base: unknown, target: unknown): unknown {
  if (equal(base, target)) return undefined;
  if (!isJsonObject(base) || !isJsonObject(target)) return clone(target);
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(target)) {
    const d = k in base ? diffPatch(base[k], v) : clone(v);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The overrides that turn `defaults` into `config` (only what differs). */
export function overridesBetween(defaults: TunableConfig, config: TunableConfig): ConfigOverrides {
  const out: ConfigOverrides = {};
  for (const file of TUNABLE_FILES) {
    const d = diffPatch(defaults[file], config[file]);
    if (isJsonObject(d)) out[file] = d;
  }
  return out;
}

/** The leaves of a patch: `[path, value]`, where arrays and non-objects are leaves. */
export function patchLeaves(patch: unknown, prefix: string[] = []): [string[], unknown][] {
  if (!isJsonObject(patch)) return [[prefix, patch]];
  return Object.entries(patch).flatMap(([k, v]) => patchLeaves(v, [...prefix, k]));
}

function setPath(target: JsonObject, path: readonly string[], value: unknown): void {
  let o = target;
  for (const key of path.slice(0, -1)) {
    if (!isJsonObject(o[key])) o[key] = {};
    o = o[key] as JsonObject;
  }
  const last = path[path.length - 1];
  if (last !== undefined) o[last] = clone(value);
}

function zodIssues(file: string, error: z.ZodError): ConfigIssue[] {
  return error.issues.map((i) => {
    const path = i.path.map(String);
    // Unknown keys are reported on their parent: name them in the path, as the patch does.
    const keys = i.code === 'unrecognized_keys' ? i.keys : [];
    const where = keys.length === 1 ? [...path, keys[0]!] : path;
    const message =
      i.code === 'unrecognized_keys'
        ? `No such setting${keys.length > 1 ? `s: ${keys.join(', ')}` : ''}`
        : i.message;
    return { file, path: where.join('.'), message };
  });
}

/** Cross-file references the schemas can't check (as `loadGameData` does for the defaults). */
export function crossCheck(game: Pick<GameData, 'gacha' | 'moves'>, cfg: TunableConfig) {
  const issues: ConfigIssue[] = [];
  cfg.levelup.rarity.tiers.forEach((tier, i) => {
    if (!game.gacha.rarities.some((r) => r.rarity === tier.gachaRarity))
      issues.push({
        file: 'levelup',
        path: `rarity.tiers.${i}.gachaRarity`,
        message: `No gacha rarity ${tier.gachaRarity}`,
      });
  });
  const cards = new Set(cfg.levelup.statCards.map((c) => c.id));
  if (cards.size !== cfg.levelup.statCards.length)
    issues.push({ file: 'levelup', path: 'statCards', message: 'Duplicate stat card id' });
  cfg.tuning.lateGrowth.offers.statIds.forEach((id, i) => {
    if (!cards.has(id))
      issues.push({
        file: 'tuning',
        path: `lateGrowth.offers.statIds.${i}`,
        message: `No level-up stat card "${id}"`,
      });
  });
  for (const move of game.moves.moves) {
    const needs = move.evolution?.requires;
    if (needs && !cards.has(needs))
      issues.push({
        file: 'levelup',
        path: 'statCards',
        message: `Stat card "${needs}" is missing (${move.id} evolves with it)`,
      });
  }
  return issues;
}

export type ValidationResult =
  { ok: true; config: TunableConfig } | { ok: false; issues: ConfigIssue[] };

/** Validates a whole config (both files, unknown keys rejected, then the cross-file checks). */
export function validateTunables(
  game: Pick<GameData, 'gacha' | 'moves'>,
  input: unknown,
): ValidationResult {
  if (!isJsonObject(input))
    return { ok: false, issues: [{ file: '', path: '', message: 'Expected an object' }] };
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(input))
    if (!(TUNABLE_FILES as readonly string[]).includes(key))
      issues.push({ file: key, path: '', message: 'Not a tunable file' });
  const tuning = TuningFileSchema.safeParse(input.tuning);
  const levelup = LevelUpFileSchema.safeParse(input.levelup);
  if (!tuning.success) issues.push(...zodIssues('tuning', tuning.error));
  if (!levelup.success) issues.push(...zodIssues('levelup', levelup.error));
  if (!tuning.success || !levelup.success || issues.length) return { ok: false, issues };
  const config = { tuning: tuning.data, levelup: levelup.data };
  const cross = crossCheck(game, config);
  return cross.length ? { ok: false, issues: cross } : { ok: true, config };
}

export interface ResolvedConfig {
  config: TunableConfig;
  /** The overrides that were applied (all of them, unless some were skipped). */
  applied: ConfigOverrides;
  /** Overrides that were left out (their defaults are used), and why. */
  skipped: ConfigIssue[];
}

/**
 * Applies stored overrides to the defaults leniently, for overrides saved under an older schema
 * (a deploy removed or renamed a setting, or tightened a rule): never throws. If the whole patch
 * is valid it's used as is; otherwise each setting (each leaf of the patch; arrays are one leaf)
 * is applied on its own, and the ones the config can't take are skipped with the reason.
 */
export function resolveOverrides(
  game: Pick<GameData, 'gacha' | 'moves'>,
  defaults: TunableConfig,
  overrides: unknown,
): ResolvedConfig {
  const skipped: ConfigIssue[] = [];
  const patch: JsonObject = {};
  if (isJsonObject(overrides)) {
    for (const [file, p] of Object.entries(overrides)) {
      if (!(TUNABLE_FILES as readonly string[]).includes(file))
        skipped.push({ file, path: '', message: 'Not a tunable file' });
      else if (!isJsonObject(p)) skipped.push({ file, path: '', message: 'Expected an object' });
      else patch[file] = p;
    }
  } else if (overrides != null) skipped.push({ file: '', path: '', message: 'Expected an object' });

  const whole = validateTunables(game, mergePatch(defaults, patch));
  if (whole.ok)
    return { config: whole.config, applied: overridesBetween(defaults, whole.config), skipped };

  // One setting at a time; a setting that only fits with a later one gets another pass.
  let current: TunableConfig = clone(defaults);
  let pending = patchLeaves(patch).filter(([path]) => path.length > 1);
  const why = new Map<string, ConfigIssue>();
  for (let progress = true; progress && pending.length;) {
    progress = false;
    const left: typeof pending = [];
    for (const [path, value] of pending) {
      const next = clone(current) as unknown as JsonObject;
      setPath(next, path, value);
      const r = validateTunables(game, next);
      if (r.ok) {
        current = r.config;
        progress = true;
      } else {
        const [file = '', ...rest] = path;
        const key = rest.join('.');
        const related = (i: ConfigIssue) =>
          i.file === file && (key.startsWith(i.path) || i.path.startsWith(key));
        const message = (r.issues.find(related) ?? r.issues[0])?.message ?? 'Invalid';
        why.set(path.join('.'), { file, path: key, message });
        left.push([path, value]);
      }
    }
    pending = left;
  }
  for (const [path] of pending) {
    const issue = why.get(path.join('.'));
    if (issue) skipped.push(issue);
  }
  return { config: current, applied: overridesBetween(defaults, current), skipped };
}

/** The defaults of the tunable files, from the validated game data. */
export function defaultTunables(game: GameData): TunableConfig {
  return { tuning: game.tuning, levelup: game.levelUp };
}

/**
 * The game data with these tunable files instead of the defaults: everything else (and every
 * lookup map that doesn't depend on them) is shared with `base`. Validate `config` first.
 */
export function gameDataWith(base: GameData, config: TunableConfig): GameData {
  // The defaults (version 0, or overrides that all match them): the same object, so caches keyed
  // on the game data (the sim's) are shared.
  if (equal(config.tuning, base.tuning) && equal(config.levelup, base.levelUp)) return base;
  return {
    ...base,
    tuning: config.tuning,
    levelUp: config.levelup,
    statCardById: indexBy(config.levelup.statCards, (c) => c.id, 'level-up card id'),
  };
}

/**
 * The game data of a run config (`RunConfig`, e.g. from the server): its files are applied over
 * `base`'s leniently (`resolveOverrides`), so a config from another build still gives a working
 * game data, with this build's defaults wherever it doesn't fit.
 */
export function gameDataForRun(
  base: GameData,
  run: { tuning?: unknown; levelup?: unknown },
): { game: GameData; skipped: ConfigIssue[] } {
  const { config, skipped } = resolveOverrides(base, defaultTunables(base), {
    tuning: run.tuning ?? {},
    levelup: run.levelup ?? {},
  });
  return { game: gameDataWith(base, config), skipped };
}
