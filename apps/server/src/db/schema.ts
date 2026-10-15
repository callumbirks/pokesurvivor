import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { BalanceRecord } from '@pokesurvivor/protocol';
import type { SaveData } from '../saves/schema.js';
import type { SavedRoom } from '../game/room.js';
import type { SavedGame } from '../game/saved.js';

/** Shared reservations fence ownership while two containers overlap during a deploy. */
export const gameRooms = pgTable('game_rooms', {
  id: text('id').primaryKey(),
  instanceId: uuid('instance_id'),
  handoff: jsonb('handoff').$type<SavedRoom>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Unique membership across both instances, including rooms waiting to be adopted. */
export const gameRoomMembers = pgTable('game_room_members', {
  userId: uuid('user_id').primaryKey(),
  roomId: text('room_id')
    .notNull()
    .references(() => gameRooms.id, { onDelete: 'cascade' }),
});

/**
 * Coop games saved when the server stops for a deploy, restored (paused, waiting for their
 * players) by the next one. A row is deleted when a server claims it.
 */
export const gameSaves = pgTable('game_saves', {
  gameId: uuid('game_id').primaryKey(),
  roomId: text('room_id').notNull(),
  /** Layout of `game` (`SAVED_GAME_VERSION`); a newer one isn't restored, only credited. */
  version: smallint('version').notNull(),
  /** Room, players and slots, the run's static info, and each player's result as of the save. */
  game: jsonb('game').$type<SavedGame>().notNull(),
  /** `JSON.stringify(sim.state)`. Text, not jsonb: jsonb reorders keys, and a restore must be exact. */
  sim: text('sim').notNull(),
  /** The build that saved it (null in development). */
  build: text('build'),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
});

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Usernames double as the public nickname; uniqueness is case-insensitive. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`)],
);

/** Login sessions. The cookie holds a random token; only its SHA-256 is stored here. */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/**
 * One server-owned save per user. Balances and the partner are typed columns (balances are
 * changed only through the ledger service); everything else is versioned JSONB validated by
 * the zod schema in `saves/schema.ts`.
 */
export const saves = pgTable(
  'saves',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    coins: integer('coins').notNull().default(0),
    ticketsX1: integer('tickets_x1').notNull().default(0),
    ticketsX10: integer('tickets_x10').notNull().default(0),
    partnerDex: integer('partner_dex'),
    partnerShiny: boolean('partner_shiny').notNull().default(false),
    /** Version of the `data` layout, for future migrations of the JSONB. */
    dataVersion: smallint('data_version').notNull(),
    data: jsonb('data').$type<SaveData>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('saves_coins_non_negative', sql`${t.coins} >= 0`),
    check('saves_tickets_x1_non_negative', sql`${t.ticketsX1} >= 0`),
    check('saves_tickets_x10_non_negative', sql`${t.ticketsX10} >= 0`),
  ],
);

export const currency = pgEnum('currency', ['coins', 'tickets_x1', 'tickets_x10']);

/** Every balance change, with why it happened. Written only by `economy/ledger.ts`. */
export const currencyLedger = pgTable(
  'currency_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currency: currency('currency').notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    /** e.g. `starting_grant`, `run_reward`, `upgrade_purchase`, `gacha_pull`. */
    reason: text('reason').notNull(),
    /** What caused it: a run id, `dex:upgrade:level`, a gacha pull id… */
    refId: text('ref_id'),
    createdAt: createdAt(),
  },
  (t) => [index('currency_ledger_user_id_idx').on(t.userId, t.createdAt)],
);

export const runMode = pgEnum('run_mode', ['solo', 'coop']);
export const runStatus = pgEnum('run_status', ['started', 'finished']);

/**
 * A run. Solo runs are created by `POST /api/runs/start` and finished by the client's summary,
 * or, when that never comes, by the timeout sweep from their last checkpoint (`timedOut`); coop
 * runs are inserted finished by the game server.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mode: runMode('mode').notNull(),
    status: runStatus('status').notNull(),
    /** Sorted participant ids joined with `,`; the group leaderboard keeps one entry per team. */
    teamKey: text('team_key').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationS: integer('duration_s'),
    /** When the latest solo checkpoint was stored (`run_players.checkpoint`). */
    checkpointAt: timestamp('checkpoint_at', { withTimezone: true }),
    /** Finished by the timeout sweep from the last checkpoint, not by a final report. */
    timedOut: boolean('timed_out').notNull().default(false),
  },
  (t) => [
    index('runs_checkpoint_idx')
      .on(t.checkpointAt)
      .where(sql`${t.status} = 'started'`),
    index('runs_leaderboard_idx')
      .on(t.mode, t.endedAt)
      .where(sql`${t.status} = 'finished'`),
  ],
);

/** One row per player in a run, with the rewards actually credited (after sanity caps). */
export const runPlayers = pgTable(
  'run_players',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pokemonDex: integer('pokemon_dex').notNull(),
    pokemonShiny: boolean('pokemon_shiny').notNull().default(false),
    level: integer('level').notNull().default(0),
    kills: integer('kills').notNull().default(0),
    bosses: integer('bosses').notNull().default(0),
    coins: integer('coins').notNull().default(0),
    ticketsX1: integer('tickets_x1').notNull().default(0),
    ticketsX10: integer('tickets_x10').notNull().default(0),
    shiniesCaught: integer('shinies_caught').array().notNull().default([]),
    /** The credited `RunProgress` (defeats by type, rift wins, …), null for older runs. */
    progress: jsonb('progress'),
    /** The summary as the client sent it, when it differs from what was credited. */
    claimed: jsonb('claimed'),
    /**
     * Solo runs: the latest checkpoint (`RunStats`, already capped), credited by the timeout
     * sweep if the final report never comes.
     */
    checkpoint: jsonb('checkpoint'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.userId] }),
    index('run_players_user_id_idx').on(t.userId),
    index('run_players_pokemon_dex_idx').on(t.pokemonDex),
  ],
);

/**
 * A player's balance record for a run (R11, `BalanceRecord`): analytics for the admin run export,
 * kept indefinitely and never read for rewards. Co-op records come from the server's sim; solo
 * ones from the client (`source`), untrusted: validated and flagged when implausible (`flags`).
 * Solo checkpoints update it, so a run credited by the timeout sweep has its last one.
 */
export const runBalance = pgTable(
  'run_balance',
  {
    runId: uuid('run_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** `BalanceRecord.v`. */
    version: smallint('version').notNull(),
    /** `server` (co-op, the server's sim) or `client` (solo, reported by the browser). */
    source: text('source').notNull(),
    record: jsonb('record').$type<BalanceRecord>().notNull(),
    /** Implausible values found in it (`balanceFlags`); empty if none. */
    flags: text('flags').array().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.userId] }),
    foreignKey({
      columns: [t.runId, t.userId],
      foreignColumns: [runPlayers.runId, runPlayers.userId],
    }).onDelete('cascade'),
  ],
);

export const friendshipStatus = pgEnum('friendship_status', ['pending', 'accepted']);

/** A friend request (pending) or friendship (accepted). At most one row per pair of users. */
export const friendships = pgTable(
  'friendships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addresseeId: uuid('addressee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: friendshipStatus('status').notNull().default('pending'),
    createdAt: createdAt(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('friendships_pair_idx').on(
      sql`least(${t.requesterId}, ${t.addresseeId})`,
      sql`greatest(${t.requesterId}, ${t.addresseeId})`,
    ),
    index('friendships_addressee_id_idx').on(t.addresseeId),
    check('friendships_not_self', sql`${t.requesterId} <> ${t.addresseeId}`),
  ],
);

/**
 * Every gacha pull (single or multi), for auditing: what was paid, the pity before and after,
 * and what came out. Ledger entries for the pull reference its id.
 */
export const gachaPulls = pgTable(
  'gacha_pulls',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    banner: text('banner').notNull(),
    count: smallint('count').notNull(),
    /** `tickets` (×1 tickets) or `tickets10` (one ×10 ticket). */
    payWith: text('pay_with').notNull(),
    cost: integer('cost').notNull(),
    pityBefore: integer('pity_before').notNull(),
    pityAfter: integer('pity_after').notNull(),
    /** `[{ dex, rarity, shiny, isNew, refund }]` in pull order. */
    results: jsonb('results').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('gacha_pulls_user_id_idx').on(t.userId, t.createdAt)],
);

/**
 * Every Pokémon prestige, for auditing: the stars it reached and the upgrade levels and banned
 * moves it reset. The ledger has a matching zero-coin `prestige` entry.
 */
export const pokemonPrestiges = pgTable(
  'pokemon_prestiges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dex: integer('dex').notNull(),
    /** Stars after this prestige. */
    stars: smallint('stars').notNull(),
    /** What it reset: `{ upgrades: { id: level }, moveBans: [moveId] }`. */
    reset: jsonb('reset').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('pokemon_prestiges_user_id_idx').on(t.userId, t.dex),
    check('pokemon_prestiges_stars_positive', sql`${t.stars} >= 1`),
  ],
);
