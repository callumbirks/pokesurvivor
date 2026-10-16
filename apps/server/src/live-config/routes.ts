// Live tuning over HTTP (docs/api.md, "Live tuning"): the published config for clients, and the
// admin endpoints to publish, list, view and revert versions and to export the overrides.
import { overridesBetween, patchLeaves, type ConfigOverrides } from '@pokesurvivor/data';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAuthHooks, currentUser } from '../auth/plugin.js';
import type { Database } from '../db/index.js';
import { ApiError, parseBody } from '../http/errors.js';
import { runConfigOf, type ConfigVersion, type LiveConfig } from './store.js';

export interface LiveConfigRoutesOptions {
  db: Database;
  secureCookies: boolean;
  liveConfig: LiveConfig;
}

const note = z.string().trim().max(500).optional();
/** The version the admin's edit is based on: a publish fails if another came since. */
const baseVersion = z.number().int().nonnegative();
const publishBody = z.object({
  config: z.object({ tuning: z.unknown(), levelup: z.unknown() }).strict(),
  note,
  baseVersion,
});
const revertBody = z.object({ version: z.number().int().nonnegative(), note, baseVersion });
const versionParams = z.object({ version: z.coerce.number().int().nonnegative() });

/** Advisory lock key that serialises publishing (any constant unique to this use). */
const PUBLISH_LOCK = 7311;

/** How many settings a set of overrides changes (each leaf; an array is one). */
const changeCount = (o: unknown) =>
  typeof o === 'object' && o
    ? Object.values(o).reduce<number>((n, p) => n + patchLeaves(p).length, 0)
    : 0;

/** A version for the admin page. */
function versionView(v: ConfigVersion) {
  return {
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
    note: v.note,
    revertedFrom: v.revertedFrom,
    overrides: v.applied,
    skipped: v.skipped,
    config: v.config,
  };
}

export function liveConfigRoutes(app: FastifyInstance, opts: LiveConfigRoutesOptions): void {
  const { db, liveConfig } = opts;
  const { requireAdmin } = createAuthHooks(opts);

  /** Publishes overrides on top of `baseVersion` (409 `config_changed` if it isn't current). */
  async function publish(
    userId: string,
    base: number,
    overrides: ConfigOverrides,
    extra: { note: string | null; revertedFrom?: number },
  ) {
    return db.transaction(async (tx) => {
      // One publish at a time, so two admins can't both publish on top of the same version.
      await tx.execute(sql`select pg_advisory_xact_lock(${PUBLISH_LOCK})`);
      const current = await liveConfig.current(tx);
      if (current.version !== base)
        throw new ApiError(
          409,
          'config_changed',
          `Version ${current.version} was published since version ${base}`,
          { current: current.version },
        );
      return liveConfig.publish(tx, { overrides, createdBy: userId, ...extra });
    });
  }

  // The published config: menus show numbers from it (runs get theirs when they start).
  app.get('/api/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return runConfigOf(await liveConfig.current());
  });

  app.get('/api/admin/config', { preHandler: requireAdmin }, async () => ({
    current: versionView(await liveConfig.current()),
    defaults: liveConfig.defaults,
  }));

  app.get('/api/admin/config/versions', { preHandler: requireAdmin }, async () => ({
    versions: (await liveConfig.history()).map((r) => ({
      version: r.id,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdByName,
      note: r.note,
      revertedFrom: r.revertedFrom,
      changes: changeCount(r.overrides),
    })),
  }));

  app.get('/api/admin/config/versions/:version', { preHandler: requireAdmin }, async (request) => {
    const { version } = parseBody(versionParams, request.params);
    const v = await liveConfig.version(version);
    if (!v) throw new ApiError(404, 'config_version_not_found', `No config version ${version}`);
    return versionView(v);
  });

  // Save = publish: new runs get it at once (no drafts).
  app.put('/api/admin/config', { preHandler: requireAdmin }, async (request) => {
    const body = parseBody(publishBody, request.body);
    const valid = liveConfig.validate(body.config);
    if (!valid.ok)
      throw new ApiError(400, 'invalid_config', 'The config is not valid', {
        issues: valid.issues,
      });
    const overrides = overridesBetween(liveConfig.defaults, valid.config);
    const current = await liveConfig.current();
    if (JSON.stringify(overrides) === JSON.stringify(current.applied) && !current.skipped.length)
      throw new ApiError(400, 'config_unchanged', 'Nothing changed');
    const v = await publish(currentUser(request).id, body.baseVersion, overrides, {
      note: body.note || null,
    });
    return versionView(v);
  });

  // Revert to an earlier version (0: the defaults): its overrides are published again as a new
  // version, minus any this build skips.
  app.post('/api/admin/config/revert', { preHandler: requireAdmin }, async (request) => {
    const body = parseBody(revertBody, request.body);
    const target = await liveConfig.version(body.version);
    if (!target)
      throw new ApiError(404, 'config_version_not_found', `No config version ${body.version}`);
    const v = await publish(currentUser(request).id, body.baseVersion, target.applied, {
      note: body.note || null,
      revertedFrom: target.version,
    });
    return versionView(v);
  });

  // "Export as patch": the overrides in effect, to merge into the JSON files in the repo
  // (`pnpm --filter @pokesurvivor/tools apply-tuning-patch <file>`).
  app.get('/api/admin/config/patch', { preHandler: requireAdmin }, async () => {
    const v = await liveConfig.current();
    return {
      format: 'pokesurvivor-tuning-patch',
      version: v.version,
      exportedAt: new Date().toISOString(),
      overrides: v.applied,
    };
  });
}
