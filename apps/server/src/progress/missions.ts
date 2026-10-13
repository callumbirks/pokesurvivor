import { POKEMON_TYPES } from '@pokesurvivor/data';
import type { Mission } from '@pokesurvivor/data';
import type { RunSummary } from '@pokesurvivor/protocol';
import { getServerData } from '../data.js';
import { ApiError } from '../http/errors.js';
import { cryptoRng, seededRng } from '../random.js';
import type { Rng } from '../random.js';
import type { MissionSet, MissionState, SaveData } from '../saves/schema.js';
import type { LockedSave } from '../saves/service.js';
import { checkAchievements } from './achievements.js';
import type { UnlockedAchievement } from './achievements.js';
import { creditReward } from './rewards.js';

export type MissionKind = 'daily' | 'weekly';

export interface Periods {
  /** `2026-10-13` */
  daily: string;
  /** ISO week, `2026-W42` */
  weekly: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The day and ISO week `date` falls in, in `timeZone` (legacy `ranking.js` `periodIds`, which
 * used Europe/Madrid; the server uses `LEADERBOARD_TIME_ZONE`, default Europe/Madrid).
 */
export function periodsAt(date: Date, timeZone: string): Periods {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const y = part('year');
  const m = part('month');
  const d = part('day');

  // ISO week: the week (Monday first) containing the year's first Thursday is week 1.
  const local = new Date(Date.UTC(y, m - 1, d));
  const weekday = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - weekday);
  const weekYear = local.getUTCFullYear();
  const week = Math.ceil(((local.getTime() - Date.UTC(weekYear, 0, 1)) / 86_400_000 + 1) / 7);
  return { daily: `${y}-${pad(m)}-${pad(d)}`, weekly: `${weekYear}-W${pad(week)}` };
}

function templates(kind: MissionKind): readonly Mission[] {
  return getServerData().missions[kind];
}

function countOf(kind: MissionKind): number {
  const { missions } = getServerData();
  return kind === 'daily' ? missions.dailyCount : missions.weeklyCount;
}

/** Rolls a goal and, for typed missions, a type (legacy `make`). */
function makeMission(def: Mission, rng: Rng): MissionState {
  const goal = def.goals[Math.floor(rng() * def.goals.length)] ?? def.goals[0] ?? 1;
  const param =
    def.param === 'type' ? (POKEMON_TYPES[Math.floor(rng() * POKEMON_TYPES.length)] ?? null) : null;
  return { id: def.id, goal, param, progress: 0, claimed: false };
}

/** Draws `n` different templates (legacy `pickSet`). */
function pickMissions(
  defs: readonly Mission[],
  n: number,
  rng: Rng,
  avoid: readonly string[] = [],
): MissionState[] {
  const pool = defs.filter((d) => !avoid.includes(d.id));
  const out: MissionState[] = [];
  while (out.length < n && pool.length > 0) {
    const [def] = pool.splice(Math.floor(rng() * pool.length), 1);
    if (def) out.push(makeMission(def, rng));
  }
  return out;
}

/**
 * The missions a user gets for a period. Deterministic in (user, period), so they're stable
 * however often they're rolled (legacy seeded with the period and the account creation time).
 */
export function rollMissions(userId: string, kind: MissionKind, period: string): MissionState[] {
  return pickMissions(templates(kind), countOf(kind), seededRng(`${period}:${userId}`));
}

/** Replaces the daily/weekly missions when their period has passed (legacy `ensure`). */
export function ensureMissions(save: LockedSave, periods: Periods): void {
  for (const kind of ['daily', 'weekly'] as const) {
    const set = save.data.missions[kind];
    if (set.period === periods[kind]) continue;
    save.data.missions[kind] = {
      period: periods[kind],
      rerolled: false,
      missions: rollMissions(save.userId, kind, periods[kind]),
    };
  }
}

const isDone = (m: MissionState) => m.progress >= m.goal;

/**
 * How much a progress event is worth to a mission, or null if the mission doesn't listen to it
 * or the event doesn't match its filter. One "event" here is the whole run's worth of it.
 */
export type MissionEvent =
  | { kind: 'run'; summary: RunSummary; pokemonTypes: readonly string[] }
  | { kind: 'mission-done'; daily: boolean };

function eventValue(def: Mission, mission: MissionState, event: MissionEvent): number | null {
  if (event.kind === 'mission-done') {
    if (def.event !== 'mission-done') return null;
    if (def.filter === 'daily' && !event.daily) return null;
    return 1;
  }
  const { summary, pokemonTypes } = event;
  const p = summary.progress;
  switch (def.event) {
    case 'defeat':
      if (def.filter === 'boss') return summary.bosses;
      if (def.filter === 'has-type')
        return mission.param ? (p.defeatsByType[mission.param] ?? 0) : 0;
      return summary.kills;
    case 'chest':
      return p.chestsOpened;
    case 'item':
      return p.itemsEquipped.length;
    case 'evolve':
      return p.movesEvolved.length;
    case 'rift-win':
      return p.riftWins.length;
    case 'run-end': {
      if (def.filter === 'has-type' && !(mission.param && pokemonTypes.includes(mission.param)))
        return null;
      if (def.value === 'minutes') return Math.floor(summary.durationS / 60);
      if (def.value === 'level') return summary.level;
      if (def.value === 'coins') return summary.coins;
      return 1;
    }
    case 'mission-done':
      return null;
  }
}

/**
 * Advances the missions that listen to `event` (legacy `advance`). Progress stops at the goal;
 * claimed and finished missions don't change.
 */
export function advanceMissions(data: SaveData, event: MissionEvent): void {
  const { missionById } = getServerData();
  for (const set of [data.missions.daily, data.missions.weekly]) {
    for (const mission of set.missions) {
      if (mission.claimed || isDone(mission)) continue;
      const def = missionById.get(mission.id);
      if (!def) continue;
      const value = eventValue(def, mission, event);
      if (value === null) continue;
      const progress =
        def.mode === 'max' ? Math.max(mission.progress, value) : mission.progress + value;
      mission.progress = Math.min(mission.goal, progress);
    }
  }
}

function missionAt(set: MissionSet, index: number): MissionState {
  const mission = set.missions[index];
  if (!mission) throw new ApiError(404, 'mission_not_found', `No mission ${index}`);
  return mission;
}

/** Claims a finished mission's reward (legacy `claim`). */
export function claimMission(
  save: LockedSave,
  kind: MissionKind,
  index: number,
): UnlockedAchievement[] {
  const set = save.data.missions[kind];
  const mission = missionAt(set, index);
  if (mission.claimed) throw new ApiError(409, 'mission_already_claimed');
  if (!isDone(mission)) throw new ApiError(409, 'mission_not_done');
  const def = getServerData().missionById.get(mission.id);
  if (!def) throw new ApiError(409, 'mission_not_found', `Mission ${mission.id} no longer exists`);

  mission.claimed = true;
  creditReward(save, def.reward, 'mission_reward', `${set.period ?? ''}:${kind}:${mission.id}`);
  save.data.stats.missionsDone += 1;
  advanceMissions(save.data, { kind: 'mission-done', daily: kind === 'daily' });
  return checkAchievements(save);
}

/**
 * Swaps an unclaimed daily mission for a different one, once a day (legacy `reroll`). The new
 * mission is random, not seeded, as in legacy.
 */
export function rerollDailyMission(save: LockedSave, index: number, rng: Rng = cryptoRng): void {
  const set = save.data.missions.daily;
  const mission = missionAt(set, index);
  if (set.rerolled) throw new ApiError(409, 'mission_reroll_used');
  if (mission.claimed) throw new ApiError(409, 'mission_already_claimed');
  const [replacement] = pickMissions(
    templates('daily'),
    1,
    rng,
    set.missions.map((m) => m.id),
  );
  if (!replacement) throw new ApiError(409, 'mission_reroll_unavailable');
  set.missions[index] = replacement;
  set.rerolled = true;
}
