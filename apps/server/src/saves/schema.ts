import { z } from 'zod';

/**
 * The JSONB part of a save (`saves.data`). Balances and the partner live in typed columns. Bump
 * `SAVE_DATA_VERSION` and add a step to `migrateSaveData` when the layout changes.
 */
export const SAVE_DATA_VERSION = 2;

/**
 * National dex number. Stored saves only check the range, so a Pokémon removed from the data
 * doesn't make saves unreadable; request bodies use `knownDexSchema` (`data.ts`) instead.
 */
export const dexSchema = z.number().int().min(1).max(9999);
/** JSON object keys are strings, so dex-keyed records use the dex number as a string. */
const dexKey = z.string().regex(/^[1-9]\d{0,3}$/);
const timestampMs = z.number().int().nonnegative();
/** id -> when it was first reached (ms since epoch). */
const unlockMap = z.record(z.string().max(64), timestampMs);

export const acquisitionSchema = z.object({
  at: timestampMs,
  from: z.enum(['starter', 'gacha', 'wild', 'rescue', 'reward']),
});
export type Acquisition = z.infer<typeof acquisitionSchema>;

export const statsSchema = z.object({
  runs: z.number().int().nonnegative(),
  groupRuns: z.number().int().nonnegative(),
  bestTimeS: z.number().int().nonnegative(),
  bestGroupTimeS: z.number().int().nonnegative(),
  bestLevel: z.number().int().nonnegative(),
  totalKills: z.number().int().nonnegative(),
  bossesTotal: z.number().int().nonnegative(),
  coinsEarned: z.number().int().nonnegative(),
  shinies: z.number().int().nonnegative(),
  pulls: z.number().int().nonnegative(),
  riftWins: z.number().int().nonnegative(),
  evolutions: z.number().int().nonnegative(),
  missionsDone: z.number().int().nonnegative(),
});
export type Stats = z.infer<typeof statsSchema>;

const missionSchema = z.object({
  /** Mission template id in `missions.json`. */
  id: z.string().max(64),
  /** The goal rolled from the template's `goals`. */
  goal: z.number().int().positive(),
  /** The Pokémon type rolled for templates with `param: "type"`, else null. */
  param: z.string().max(16).nullable(),
  progress: z.number().nonnegative(),
  claimed: z.boolean(),
});
export type MissionState = z.infer<typeof missionSchema>;

const missionSetSchema = z.object({
  /** The day (`2026-10-13`) or ISO week (`2026-W42`) the missions belong to. */
  period: z.string().max(16).nullable(),
  /** Whether a mission was swapped this period (once a day, dailies only). */
  rerolled: z.boolean(),
  missions: z.array(missionSchema).max(16),
});
export type MissionSet = z.infer<typeof missionSetSchema>;

/** Up to 4 move slots; each holds a move id or null (original `pbind`). */
export const MOVE_SLOTS = 4;
/** Most moves a Pokémon can ban (the `ban` upgrade's max level decides how many are usable). */
export const MAX_MOVE_BANS = 3;

export const MAX_FAVOURITES = 3;

export const favouriteSchema = z.object({ dex: dexSchema, shiny: z.boolean() });
export type Favourite = z.infer<typeof favouriteSchema>;

export const profileSchema = z.object({
  /** Up to three Pokémon shown on the public profile. */
  favourites: z.array(favouriteSchema).max(MAX_FAVOURITES),
  /**
   * The title shown under the name. Titles are unlocked by achievements, so this is the id of
   * an unlocked achievement (whose title text comes from `packages/data`), or null.
   */
  title: z.string().max(64).nullable(),
});
export type Profile = z.infer<typeof profileSchema>;

export const settingsSchema = z.object({
  quality: z.enum(['auto', 'high', 'medium', 'low']),
  damageNumbers: z.boolean(),
  /** Fewer screen shakes and flashes. */
  calmMode: z.boolean(),
  showFps: z.boolean(),
  /** Size of the touch joystick. */
  stickScale: z.number().min(0.5).max(2),
  musicVolume: z.number().min(0).max(1),
  sfxVolume: z.number().min(0).max(1),
  muted: z.boolean(),
});
export type Settings = z.infer<typeof settingsSchema>;

export const saveDataSchema = z.object({
  owned: z.record(dexKey, acquisitionSchema),
  shiny: z.record(dexKey, acquisitionSchema),
  /** The starter chosen after the personality test (or picked directly). */
  starter: dexSchema.nullable(),
  /** The personality test result, if it was taken: top trait and points per trait. */
  personality: z
    .object({
      trait: z.string().max(32),
      scores: z.record(z.string().max(32), z.number().int().nonnegative()),
    })
    .nullable(),
  /** dex -> upgrade id -> level bought. */
  upgrades: z.record(dexKey, z.record(z.string().max(32), z.number().int().nonnegative())),
  /** dex -> move id fixed in each of the 4 slots, or null (original `pbind`). */
  moveBindings: z.record(dexKey, z.array(z.string().max(32).nullable()).length(MOVE_SLOTS)),
  /** dex -> moves that never show up in level-up cards (original `pban`, `ban` upgrade). */
  moveBans: z.record(dexKey, z.array(z.string().max(32)).max(MAX_MOVE_BANS)),
  /** Gacha banner id -> pulls since the last 5★. */
  pity: z.record(z.string().max(32), z.number().int().nonnegative()),
  stats: statsSchema,
  achievements: unlockMap,
  /** Legendaries beaten in rifts, rift arenas won, items found, moves evolved. */
  legendsBeaten: unlockMap,
  arenasWon: unlockMap,
  itemsFound: unlockMap,
  movesEvolved: unlockMap,
  missions: z.object({ daily: missionSetSchema, weekly: missionSetSchema }),
  profile: profileSchema,
  settings: settingsSchema,
});
export type SaveData = z.infer<typeof saveDataSchema>;

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto',
  damageNumbers: true,
  calmMode: false,
  showFps: false,
  stickScale: 1,
  musicVolume: 0.55,
  sfxVolume: 0.7,
  muted: false,
};

export function newSaveData(): SaveData {
  return {
    owned: {},
    shiny: {},
    starter: null,
    personality: null,
    upgrades: {},
    moveBindings: {},
    moveBans: {},
    pity: {},
    stats: {
      runs: 0,
      groupRuns: 0,
      bestTimeS: 0,
      bestGroupTimeS: 0,
      bestLevel: 0,
      totalKills: 0,
      bossesTotal: 0,
      coinsEarned: 0,
      shinies: 0,
      pulls: 0,
      riftWins: 0,
      evolutions: 0,
      missionsDone: 0,
    },
    achievements: {},
    legendsBeaten: {},
    arenasWon: {},
    itemsFound: {},
    movesEvolved: {},
    missions: {
      daily: { period: null, rerolled: false, missions: [] },
      weekly: { period: null, rerolled: false, missions: [] },
    },
    profile: { favourites: [], title: null },
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Legacy upgrade ids (used by save version 1) -> the ids in `upgrades.json`. */
const V1_UPGRADE_IDS: Record<string, string> = {
  hp: 'max-hp',
  atk: 'attack',
  spd: 'speed',
  cd: 'cooldown',
  def: 'defense',
  xp: 'experience',
  moves: 'extra-move',
};

/**
 * Version 1 -> 2: upgrade ids switch to the `upgrades.json` ids; missions gain a rolled goal and
 * type (v1 never rolled any, so they reset); personality, move bindings and bans are added.
 */
function migrateV1(data: Record<string, unknown>): Record<string, unknown> {
  const upgrades = (data.upgrades ?? {}) as Record<string, Record<string, number>>;
  const renamed = Object.fromEntries(
    Object.entries(upgrades).map(([dex, levels]) => [
      dex,
      Object.fromEntries(Object.entries(levels).map(([id, l]) => [V1_UPGRADE_IDS[id] ?? id, l])),
    ]),
  );
  const fresh = newSaveData();
  return {
    ...data,
    upgrades: renamed,
    personality: null,
    moveBindings: {},
    moveBans: {},
    missions: fresh.missions,
  };
}

/** Brings stored data of any known version up to `SAVE_DATA_VERSION` and validates it. */
export function migrateSaveData(version: number, data: unknown): SaveData {
  if (version > SAVE_DATA_VERSION)
    throw new Error(`Save data version ${version} is newer than this server`);
  let current = data as Record<string, unknown>;
  if (version < 2) current = migrateV1(current);
  return saveDataSchema.parse(current);
}
