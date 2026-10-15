// Live tuning on the server: the published config versions (`config_versions`), each resolved
// into the game data runs play with. New runs get the newest version (`current`); a run keeps the
// version it started with, and a saved coop game is restored with the config it was saved with.
import {
  defaultTunables,
  gameDataWith,
  loadGameData,
  resolveOverrides,
  validateTunables,
  type ConfigIssue,
  type ConfigOverrides,
  type GameData,
  type RunConfig,
  type TunableConfig,
} from '@pokesurvivor/data';
import { desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../db/index.js';
import { configVersions, users } from '../db/schema.js';

/** A published config version, resolved against this build's defaults. */
export interface ConfigVersion {
  version: number;
  createdAt: Date;
  /** Username of the admin who published it (null: version 0, or a deleted account). */
  createdBy: string | null;
  note: string | null;
  /** Published by reverting to this version. */
  revertedFrom: number | null;
  /** The overrides as stored. */
  overrides: unknown;
  /** The overrides in effect: the stored ones minus `skipped`. */
  applied: ConfigOverrides;
  /**
   * Stored overrides this build can't apply (a setting a deploy removed, or a value its schema
   * no longer accepts): their defaults are used instead. Shown on the admin page.
   */
  skipped: ConfigIssue[];
  /** The effective tunable files. */
  config: TunableConfig;
  /** The game data runs of this version play with (the built-in object when nothing changes). */
  game: GameData;
}

/** What a run is issued (`RunConfig`): the version and its effective files. */
export function runConfigOf(v: ConfigVersion): RunConfig {
  return { version: v.version, tuning: v.config.tuning, levelup: v.config.levelup };
}

type Row = typeof configVersions.$inferSelect & { createdByName: string | null };

const columns = {
  id: configVersions.id,
  overrides: configVersions.overrides,
  createdBy: configVersions.createdBy,
  createdByName: users.username,
  note: configVersions.note,
  revertedFrom: configVersions.revertedFrom,
  createdAt: configVersions.createdAt,
};

export class LiveConfig {
  private readonly base = loadGameData();
  readonly defaults: TunableConfig = defaultTunables(this.base);
  /** Resolved versions by id (versions never change, so they never go stale). */
  private readonly cache = new Map<number, ConfigVersion>();

  constructor(
    private readonly db: Database,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * The newest version: what new runs get. Reads the newest id from the database every time, so
   * a version published through another server instance applies at once.
   */
  async current(db: Executor = this.db): Promise<ConfigVersion> {
    const [row] = await db
      .select(columns)
      .from(configVersions)
      .leftJoin(users, eq(users.id, configVersions.createdBy))
      .orderBy(desc(configVersions.id))
      .limit(1);
    // The migration inserts version 0; without it, the defaults.
    return row ? this.resolve(row) : this.defaultsVersion();
  }

  /** A published version, or null if there's no such version. */
  async version(id: number): Promise<ConfigVersion | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const [row] = await this.db
      .select(columns)
      .from(configVersions)
      .leftJoin(users, eq(users.id, configVersions.createdBy))
      .where(eq(configVersions.id, id));
    return row ? this.resolve(row) : null;
  }

  /** Validates a whole config for publishing (strict: nothing is skipped). */
  validate(input: unknown) {
    return validateTunables(this.base, input);
  }

  /** Every version, newest first (without resolving them). */
  async history(): Promise<Row[]> {
    return this.db
      .select(columns)
      .from(configVersions)
      .leftJoin(users, eq(users.id, configVersions.createdBy))
      .orderBy(desc(configVersions.id));
  }

  /** Publishes overrides as a new version (it applies to new runs from now on). */
  async publish(
    db: Executor,
    v: {
      overrides: ConfigOverrides;
      createdBy: string;
      note: string | null;
      revertedFrom?: number | null;
    },
  ): Promise<ConfigVersion> {
    const [row] = await db
      .insert(configVersions)
      .values({
        overrides: v.overrides,
        createdBy: v.createdBy,
        note: v.note,
        revertedFrom: v.revertedFrom ?? null,
      })
      .returning({ id: configVersions.id });
    if (!row) throw new Error('insert returned no row');
    const published = await this.current(db);
    this.log.info({ version: published.version, by: v.createdBy }, 'published a config version');
    return published;
  }

  /**
   * The game data of a run config issued earlier (a saved coop game's), applied over this
   * build's defaults leniently: settings this build doesn't have keep its defaults.
   */
  gameForRun(run: { tuning?: unknown; levelup?: unknown }): GameData {
    const { config, skipped } = resolveOverrides(this.base, this.defaults, {
      tuning: run.tuning ?? {},
      levelup: run.levelup ?? {},
    });
    if (skipped.length)
      this.log.warn({ skipped }, 'a saved run config has settings this build skips');
    return gameDataWith(this.base, config);
  }

  private defaultsVersion(): ConfigVersion {
    return {
      version: 0,
      createdAt: new Date(0),
      createdBy: null,
      note: null,
      revertedFrom: null,
      overrides: {},
      applied: {},
      skipped: [],
      config: this.defaults,
      game: this.base,
    };
  }

  private resolve(row: Row): ConfigVersion {
    const hit = this.cache.get(row.id);
    if (hit) return hit;
    const { config, applied, skipped } = resolveOverrides(this.base, this.defaults, row.overrides);
    if (skipped.length)
      this.log.warn(
        { version: row.id, skipped },
        'config version has overrides this build skips (their defaults apply)',
      );
    const v: ConfigVersion = {
      version: row.id,
      createdAt: row.createdAt,
      createdBy: row.createdByName,
      note: row.note,
      revertedFrom: row.revertedFrom,
      overrides: row.overrides,
      applied,
      skipped,
      config,
      game: gameDataWith(this.base, config),
    };
    this.cache.set(row.id, v);
    return v;
  }
}
