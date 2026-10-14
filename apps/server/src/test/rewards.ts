import type { AchievementMetric } from '@pokesurvivor/data';
import { getServerData } from '../data.js';

/** Expected unlocks from a test's metric counters, using the shipped goals and rewards. */
export function expectedAchievements(
  metrics: Partial<Record<AchievementMetric, number>>,
  legends: number[] = [],
) {
  return getServerData().achievements.achievements.filter((a) => {
    const value =
      a.metric === 'legendary-defeated'
        ? Number(a.dex !== undefined && legends.includes(a.dex))
        : (metrics[a.metric] ?? 0);
    return value >= a.goal;
  });
}

export function rewardTotals(achievements: ReturnType<typeof expectedAchievements>) {
  return achievements.reduce(
    (sum, a) => ({
      coins: sum.coins + (a.reward.coins ?? 0),
      tickets: sum.tickets + (a.reward.tickets ?? 0),
      tickets10: sum.tickets10 + (a.reward.tickets10 ?? 0),
    }),
    { coins: 0, tickets: 0, tickets10: 0 },
  );
}
