import type { Achievement, AchievementMetric } from '@pokesurvivor/data';
import { getServerData } from '../data.js';
import type { SaveData } from '../saves/schema.js';
import type { LockedSave } from '../saves/service.js';
import { creditReward } from './rewards.js';

const count = (record: Record<string, unknown>) => Object.keys(record).length;

/** An achievement's current value in a save (legacy `achievements.js` `value(save)`). */
export function achievementValue(data: SaveData, achievement: Achievement): number {
  const s = data.stats;
  const metric: AchievementMetric = achievement.metric;
  switch (metric) {
    case 'pokemon-owned': {
      const { pokemonByDex } = getServerData();
      return Object.keys(data.owned).filter((dex) => pokemonByDex.has(Number(dex))).length;
    }
    case 'shinies-owned':
      return count(data.shiny);
    case 'gacha-pulls':
      return s.pulls;
    case 'best-time-minutes':
      return Math.floor(s.bestTimeS / 60);
    case 'best-level':
      return s.bestLevel;
    case 'runs':
      return s.runs;
    case 'total-defeated':
      return s.totalKills;
    case 'bosses-defeated':
      return s.bossesTotal;
    case 'move-evolutions':
      return s.evolutions;
    case 'distinct-moves-evolved':
      return count(data.movesEvolved);
    case 'distinct-items-found':
      return count(data.itemsFound);
    case 'rift-wins':
      return s.riftWins;
    case 'arenas-won':
      return count(data.arenasWon);
    case 'legendaries-defeated':
      return count(data.legendsBeaten);
    case 'legendary-defeated':
      return achievement.dex !== undefined && data.legendsBeaten[String(achievement.dex)] ? 1 : 0;
    case 'missions-done':
      return s.missionsDone;
    case 'group-runs':
      return s.groupRuns;
  }
}

export interface UnlockedAchievement {
  id: string;
  reward: Achievement['reward'];
  title: string | null;
}

/**
 * Unlocks every achievement the save now qualifies for and credits its reward through the
 * ledger (legacy `checkAch`). Call after anything that changes the stats or collection.
 * Returns the newly unlocked ones, for the client's toasts.
 */
export function checkAchievements(save: LockedSave, now = Date.now()): UnlockedAchievement[] {
  const unlocked: UnlockedAchievement[] = [];
  for (const achievement of getServerData().achievements.achievements) {
    if (save.data.achievements[achievement.id] !== undefined) continue;
    if (achievementValue(save.data, achievement) < achievement.goal) continue;
    save.data.achievements[achievement.id] = now;
    creditReward(save, achievement.reward, 'achievement_reward', achievement.id);
    unlocked.push({
      id: achievement.id,
      reward: achievement.reward,
      title: achievement.title ?? null,
    });
  }
  return unlocked;
}
