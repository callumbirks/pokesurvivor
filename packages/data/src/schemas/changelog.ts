import { z } from 'zod';
import { TextSchema } from './common.js';

/**
 * One section's lines: short, player-facing, English. Kept as plain strings so they can later
 * become i18n keys without changing the file's shape.
 */
const LinesSchema = z.array(TextSchema).optional();

/** What changed, grouped like Keep a Changelog. `behindTheScenes` is shown muted. */
export const ChangelogEntriesSchema = z.strictObject({
  new: LinesSchema,
  changed: LinesSchema,
  fixed: LinesSchema,
  behindTheScenes: LinesSchema,
});
export type ChangelogEntries = z.infer<typeof ChangelogEntriesSchema>;

/** The sections in display order. */
export const CHANGELOG_SECTIONS = ['new', 'changed', 'fixed', 'behindTheScenes'] as const;
export type ChangelogSection = (typeof CHANGELOG_SECTIONS)[number];

const PrsSchema = z.array(z.number().int().positive());

/** Calendar date, `YYYY-MM-DD`. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'expected a valid date');

/** Whether `entries` has at least one line. */
export function hasEntries(entries: ChangelogEntries): boolean {
  return CHANGELOG_SECTIONS.some((k) => (entries[k]?.length ?? 0) > 0);
}

export const ChangelogVersionSchema = z.strictObject({
  /** 1, 2, 3, … shown as v1, v2, v3. */
  version: z.number().int().positive(),
  date: IsoDateSchema,
  prs: PrsSchema,
  entries: ChangelogEntriesSchema.refine(hasEntries, 'a released version needs at least one line'),
});
export type ChangelogVersion = z.infer<typeof ChangelogVersionSchema>;

/**
 * `changelog.json`: released versions, newest first, numbered 1…N without gaps, and the
 * `unreleased` block that PRs add to (`pnpm release` turns it into version N+1).
 */
export const ChangelogFileSchema = z
  .strictObject({
    /**
     * A temporary look for the main menu's What's new button, to point players at a big
     * addition (`mega`: Mega Evolution). null or absent: the usual gold notice. Switched off by
     * hand; `pnpm release` keeps it.
     */
    whatsNewTheme: z.enum(['mega']).nullable().optional(),
    unreleased: z.strictObject({ prs: PrsSchema, entries: ChangelogEntriesSchema }),
    versions: z.array(ChangelogVersionSchema),
  })
  .superRefine((file, ctx) => {
    const n = file.versions.length;
    file.versions.forEach((v, i) => {
      if (v.version !== n - i)
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'version'],
          message: `expected version ${n - i}: versions are newest first, numbered 1…${n}`,
        });
      const older = file.versions[i + 1];
      if (older && v.date < older.date)
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'date'],
          message: `v${v.version} is dated before v${older.version}`,
        });
    });
  });
export type ChangelogFile = z.infer<typeof ChangelogFileSchema>;
