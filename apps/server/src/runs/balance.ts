// Balance records (R11): validation of the `balance` a run summary carries, and the implausible
// values flagged on it for the admin run export. Records are analytics only: a solo client's is
// untrusted, so it is checked for shape and size here and dropped if it fails, and it never
// changes what a run is credited with.
import { BALANCE_RECORD_VERSION, type BalanceRecord } from '@pokesurvivor/protocol';
import type { GameData } from '@pokesurvivor/data';
import { z } from 'zod';
import { getServerData } from '../data.js';

/** Largest record accepted (JSON characters): a 30-minute run is about 25 000. */
export const MAX_BALANCE_BYTES = 160_000;

const num = z.number().finite();
const nonneg = z.number().finite().nonnegative();
const int = z.number().int().nonnegative().max(1e12);
const id = z.string().max(64);
const time = nonneg.max(24 * 3600);

const hitSource = z.strictObject({
  kind: z.enum(['contact', 'shot', 'zone', 'beam', 'liquid', 'trap', 'weather']),
  dex: z.number().int().nonnegative().max(100_000).optional(),
  tier: z.enum(['wild', 'elite', 'boss', 'legend', 'wildLegend']).optional(),
});

const sample = z.strictObject({
  t: time,
  lv: int,
  hp: num,
  maxHp: nonneg,
  atk: nonneg,
  atkCard: nonneg,
  atkUpgrade: nonneg,
  atkItem: nonneg,
  atkPrestige: nonneg,
  atkOther: nonneg,
  atkBuff: nonneg,
  atkMomentum: nonneg,
  cd: nonneg,
  def: num,
  regen: num,
  spd: nonneg,
  crit: num,
  kills: int,
  lastHits: int,
  dealt: num,
  taken: num,
  mom: nonneg,
  momAvg: nonneg,
  enemies: int,
  downs: int,
  revives: int,
  down: z.literal(true).optional(),
  rift: z.literal(true).optional(),
});

/** The shape of a `BalanceRecord` (`packages/protocol`), with bounds on every list and number. */
export const balanceRecordSchema = z.strictObject({
  v: z.literal(BALANCE_RECORD_VERSION),
  setup: z.strictObject({
    dex: z.number().int().nonnegative(),
    shiny: z.boolean(),
    prestige: z.number().int().min(0).max(100),
    upgrades: z.record(id, z.number().int().nonnegative().max(1000)),
    players: z.number().int().min(1).max(8),
    startMoves: z.array(id).max(8),
    from: time,
  }),
  end: z.strictObject({
    t: time,
    reason: z.enum(['all-down', 'everyone-left']).nullable(),
    left: z.boolean(),
    level: int,
    kills: int,
    lastHits: int,
    damageDealt: nonneg,
    damageTaken: nonneg,
    downs: int,
    revivesGiven: int,
    item: id.nullable(),
    rerolls: int,
  }),
  moves: z
    .array(
      z.strictObject({
        id,
        level: int,
        evolved: z.boolean(),
        learnedAt: time,
        evolvedAt: time.nullable(),
      }),
    )
    .max(32),
  items: z.array(z.strictObject({ t: time, id })).max(200),
  picks: z
    .array(
      z.strictObject({
        t: time,
        lv: int,
        card: id,
        rarity: id.optional(),
        value: num.optional(),
        auto: z.literal(true).optional(),
        declined: z.array(id).max(8),
      }),
    )
    .max(2000),
  timeline: z.array(sample).max(24 * 60 + 1),
  downs: z
    .array(
      z.strictObject({
        t: time,
        by: hitSource.nullable(),
        taken10s: nonneg,
        rift: z.literal(true).optional(),
        revivedAt: time.nullable(),
      }),
    )
    .max(2000),
  rifts: z
    .array(
      z.strictObject({
        t: time,
        dex: z.number().int().nonnegative(),
        type: id,
        result: z.enum(['won', 'lost']).nullable(),
        dur: time,
      }),
    )
    .max(500),
  wildLegends: z
    .array(
      z.strictObject({
        t: time,
        dex: z.number().int().nonnegative(),
        maxHp: nonneg,
        defeatedAt: time.nullable(),
        dealt: nonneg,
        top: z.literal(true).optional(),
      }),
    )
    .max(2000)
    .optional(),
}) satisfies z.ZodType<BalanceRecord>;

export type BalanceParse = { ok: true; record: BalanceRecord } | { ok: false; reason: string };

/** Checks a reported record's size and shape. Absent → `null`. */
export function parseBalance(raw: unknown): BalanceParse | null {
  if (raw === undefined || raw === null) return null;
  // Checked before parsing the shape: a huge payload is refused without walking it.
  const size = JSON.stringify(raw).length;
  if (size > MAX_BALANCE_BYTES) return { ok: false, reason: `too large (${size} bytes)` };
  const r = balanceRecordSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, reason: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}` };
  }
  return { ok: true, record: r.data };
}

/** What the server knows about the run, to check the record against. */
export interface BalanceContext {
  /** The run's duration (s) as reported in its summary (before any capping). */
  durationS: number;
  /** Level and kills the summary reported (before any capping). */
  level: number;
  kills: number;
  /** The Pokémon the run was started with. */
  dex: number;
  /** The server capped the claim. */
  capped?: boolean;
  /** The game data of the run's config version (default: the server's built-in data). */
  game?: GameData;
  /** For solo: the player's save as of now, to check the setup against. */
  save?: { prestige: number; upgrades: Readonly<Record<string, number>> };
}

/** Tolerance on rounded multipliers (records keep 3 decimals). */
const EPS = 1e-3;

/**
 * Implausible values in a record, for the export to filter on. Each flag names one check:
 *   claim-capped             the server capped the run's claimed rewards
 *   setup-dex                the record's Pokémon isn't the one the run started with
 *   setup-above-save         prestige or an upgrade level above what the save has
 *   end-vs-summary           level, kills or duration differ from the summary's
 *   timeline-vs-duration     samples out of order, past the end, or not one per minute
 *   picks-above-levels       more cards taken than level-ups (or Power picks alone)
 *   atk-card-above-cap       the Power multiplier above its ceiling
 *   atk-card-vs-picks        the Power multiplier above what the Power picks taken could
 *                            build (all at the top rarity), or a pick above that rarity's value
 *   defense-above-max        defence above `tuning.defense.max`
 *   crit-above-max           crit chance above 1
 * The checks use the game data of the run's config version (live tuning).
 */
export function balanceFlags(rec: BalanceRecord, run: BalanceContext): string[] {
  const d = run.game ?? getServerData();
  const flags = new Set<string>();
  const end = rec.end;
  if (run.capped) flags.add('claim-capped');

  if (rec.setup.dex !== run.dex) flags.add('setup-dex');
  if (run.save) {
    if (rec.setup.prestige > run.save.prestige) flags.add('setup-above-save');
    for (const [k, lv] of Object.entries(rec.setup.upgrades))
      if (lv > (run.save.upgrades[k] ?? 0)) flags.add('setup-above-save');
  }

  if (
    end.level !== run.level ||
    end.kills !== run.kills ||
    Math.abs(Math.floor(end.t) - run.durationS) > 2
  )
    flags.add('end-vs-summary');

  // One sample per whole minute from the record's start, then maybe one for the last seconds.
  const tl = rec.timeline;
  const whole = tl.filter((x) => x.t % 60 === 0 && x.t > 0);
  const firstMinute = Math.floor(rec.setup.from / 60) + 1;
  const expected = Math.max(0, Math.floor(end.t / 60) - firstMinute + 1);
  const ordered = tl.every((x, i) => i === 0 || x.t > tl[i - 1]!.t);
  if (
    !ordered ||
    tl.some((x) => x.t > end.t + 1) ||
    whole.length < expected - 1 ||
    whole.length > expected ||
    whole.some((x, i) => x.t !== (firstMinute + i) * 60) ||
    tl.some((x) => x.lv > end.level)
  )
    flags.add('timeline-vs-duration');

  // A card per player per level-up (from level 2).
  const atkCards = d.levelUp.statCards.filter(
    (c) => c.effect.type === 'stat' && c.effect.stat === 'attackMul',
  );
  const atkIds = new Set(atkCards.map((c) => `stat:${c.id}`));
  const powerPicks = rec.picks.filter((k) => atkIds.has(k.card));
  if (rec.picks.length > Math.max(0, end.level - 1) || powerPicks.length > end.level)
    flags.add('picks-above-levels');

  const atkCap = atkCards.reduce(
    (k, c) => k * (c.effect.type === 'stat' ? (c.effect.cap ?? Infinity) : 1),
    1,
  );
  // The most one Power pick can add: its value at the top rarity.
  const topTier = Math.max(1, ...d.levelUp.rarity.tiers.map((t) => t.multiplier));
  const topValue = (card: string) => {
    const e = d.statCardById.get(card.slice('stat:'.length))?.effect;
    return e?.type === 'stat' && e.op === 'mul' ? 1 + (e.value - 1) * topTier : Infinity;
  };
  if (powerPicks.some((k) => k.value !== undefined && k.value > topValue(k.card) + EPS))
    flags.add('atk-card-vs-picks');
  const defMax = d.tuning.defense.max;
  for (const x of tl) {
    if (x.atkCard > atkCap * (1 + EPS)) flags.add('atk-card-above-cap');
    // What the Power picks taken by then could build at most (all at the top rarity).
    let built = 1;
    for (const k of powerPicks) if (k.t <= x.t) built *= topValue(k.card);
    if (x.atkCard > Math.min(atkCap, built) * (1 + 0.01)) flags.add('atk-card-vs-picks');
    if (x.def > defMax + EPS) flags.add('defense-above-max');
    if (x.crit > 1 + EPS) flags.add('crit-above-max');
  }
  return [...flags].sort();
}
