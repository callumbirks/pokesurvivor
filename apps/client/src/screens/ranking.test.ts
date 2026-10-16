// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { LeaderboardEntry } from '../app/api.js';
import { rankingRow } from './ranking.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', () => ({
  iconImg: (id: string) => Object.assign(document.createElement('img'), { alt: id }),
  iconUrl: () => '',
  typeColor: () => '#ffffff',
}));

const player = (username: string, level: number, kills: number) => ({
  username,
  pokemon: { dex: 25, shiny: false },
  level,
  kills,
});

const stats = (row: HTMLElement) => row.querySelector('.who small')?.textContent;

describe('leaderboard rows', () => {
  it('shows a group run’s level and Pokémon defeated once, not once per player', () => {
    const entry: LeaderboardEntry = {
      rank: 4,
      durationS: 1203,
      endedAt: '2026-10-13T09:12:00.000Z',
      level: 40,
      kills: 900,
      // Carol left early, with what the team had then.
      players: [player('Ash', 40, 900), player('Brock', 40, 900), player('Carol', 31, 550)],
    };
    const row = rankingRow(entry, false);
    expect(stats(row)).toBe('Lv. 40 · 900 defeated');
    expect(row.querySelector('.who b')?.textContent).toBe('Ash · Brock · Carol');
    expect(row.querySelectorAll('.mini')).toHaveLength(3);
  });

  it('falls back to the first player’s values from an older server', () => {
    const entry: LeaderboardEntry = {
      rank: 1,
      durationS: 600,
      endedAt: '2026-10-13T09:12:00.000Z',
      players: [player('Ash', 40, 900), player('Brock', 40, 900)],
    };
    expect(stats(rankingRow(entry, true))).toBe('Lv. 40 · 900 defeated');
  });

  it('shows a solo run as before', () => {
    const entry: LeaderboardEntry = {
      rank: 2,
      durationS: 300,
      endedAt: '2026-10-13T09:12:00.000Z',
      level: 12,
      kills: 140,
      players: [player('Ash', 12, 140)],
    };
    expect(stats(rankingRow(entry, false))).toBe('Lv. 12 · 140 defeated');
  });
});
