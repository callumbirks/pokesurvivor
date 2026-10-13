import { loadGameData } from '@pokesurvivor/data';
import { describe, expect, it } from 'vitest';
import { AchievementTracker, type AchievementSave } from './achievements.js';

function save(over: Partial<AchievementSave> = {}): AchievementSave {
  return {
    stats: {
      bestTimeS: 0,
      bestLevel: 0,
      totalKills: 0,
      bossesTotal: 0,
      evolutions: 0,
      riftWins: 0,
      pulls: 0,
      runs: 0,
      groupRuns: 0,
      missionsDone: 0,
    },
    achievements: {},
    owned: { 25: {} },
    shiny: {},
    movesEvolved: {},
    itemsFound: {},
    arenasWon: {},
    legendsBeaten: {},
    ...over,
  };
}

const defs = loadGameData().achievements.achievements;
const byMetric = (m: string) => defs.filter((a) => a.metric === m).sort((a, b) => a.goal - b.goal);
const team = (
  o: Partial<{ kills: number; bosses: number; level: number; shinies: number[] }> = {},
) => ({
  kills: 0,
  bosses: 0,
  level: 1,
  shinies: [],
  ...o,
});

describe('mid-run achievement notices', () => {
  it('fires once when the save plus this run reaches a goal', () => {
    const first = byMetric('total-defeated')[0]!;
    const t = new AchievementTracker(
      save({ stats: { ...save().stats, totalKills: first.goal - 10 } }),
      'me',
    );
    t.observe(team({ kills: 9 }), 60);
    expect(t.check().map((a) => a.id)).not.toContain(first.id);
    t.observe(team({ kills: 10 }), 61);
    expect(t.check().map((a) => a.id)).toContain(first.id);
    t.observe(team({ kills: 11 }), 62);
    expect(t.check().map((a) => a.id)).not.toContain(first.id);
  });

  it('skips achievements already unlocked and those only the end of a run moves', () => {
    const first = byMetric('best-level')[0]!;
    const runs = byMetric('runs')[0]!;
    const t = new AchievementTracker(save({ achievements: { [first.id]: 1 } }), 'me');
    t.observe(team({ level: 99 }), 10);
    const ids = t.check().map((a) => a.id);
    expect(ids).not.toContain(first.id);
    expect(ids).not.toContain(runs.id);
  });

  it('counts survival time in whole minutes against the best time', () => {
    const a = byMetric('best-time-minutes')[0]!;
    const t = new AchievementTracker(save(), 'me');
    t.observe(team(), a.goal * 60 - 1);
    expect(t.check().map((x) => x.id)).not.toContain(a.id);
    t.observe(team(), a.goal * 60);
    expect(t.check().map((x) => x.id)).toContain(a.id);
  });

  it('follows progress events: evolutions, items, rift wins and legendaries', () => {
    const t = new AchievementTracker(save({ itemsFound: { leftovers: 1 } }), 'me');
    t.event({ type: 'progress', event: 'evolve', playerId: 'me', data: { move: 'ember' } });
    t.event({ type: 'progress', event: 'evolve', playerId: 'other', data: { move: 'gust' } });
    t.event({ type: 'progress', event: 'item', playerId: 'me', data: { id: 'leftovers' } });
    t.event({ type: 'progress', event: 'item', playerId: 'me', data: { id: 'life-orb' } });
    t.event({ type: 'progress', event: 'rift-win', playerId: null, data: { type: 'fire' } });
    t.event({
      type: 'progress',
      event: 'defeat',
      playerId: null,
      data: { types: ['ice', 'flying'], boss: true, legend: 144 },
    });
    const value = (metric: string, dex?: number) =>
      t.value({ ...byMetric(metric)[0]!, ...(dex ? { dex } : {}) });
    expect(value('move-evolutions')).toBe(1);
    expect(value('distinct-moves-evolved')).toBe(1);
    expect(value('distinct-items-found')).toBe(2);
    expect(value('rift-wins')).toBe(1);
    expect(value('arenas-won')).toBe(1);
    expect(value('legendaries-defeated')).toBe(1);
    expect(value('legendary-defeated', 144)).toBe(1);
    expect(value('legendary-defeated', 145)).toBe(0);
    const articuno = defs.find((a) => a.metric === 'legendary-defeated' && a.dex === 144);
    if (articuno) expect(t.check().map((a) => a.id)).toContain(articuno.id);
  });

  it('counts shinies and rescued Pokémon towards the collection', () => {
    const t = new AchievementTracker(save({ owned: { 25: {}, 133: {} } }), 'me');
    t.observe(team({ shinies: [133, 7] }), 30);
    t.event({ type: 'lost-pokemon', phase: 'rescued', dex: 16, joins: true });
    t.event({ type: 'lost-pokemon', phase: 'rescued', dex: 19, joins: false });
    expect(t.value(byMetric('pokemon-owned')[0]!)).toBe(4); // 25, 133, 7, 16
    expect(t.value(byMetric('shinies-owned')[0]!)).toBe(2);
  });
});
