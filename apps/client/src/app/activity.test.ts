import { describe, expect, it } from 'vitest';
import { activityLabel, formatRunTime, runClock, type ActivityEntry } from './activity.js';

const solo = (elapsedS: number, paused = false): ActivityEntry => ({
  activity: { kind: 'solo', dex: 25, shiny: false, elapsedS, ...(paused ? { paused: true } : {}) },
  at: 1_000,
});

describe('formatRunTime', () => {
  it('shows minutes and seconds, and hours from an hour', () => {
    expect(formatRunTime(0)).toBe('0:00');
    expect(formatRunTime(9.9)).toBe('0:09');
    expect(formatRunTime(215)).toBe('3:35');
    expect(formatRunTime(59 * 60 + 59)).toBe('59:59');
    expect(formatRunTime(3600)).toBe('1:00:00');
    expect(formatRunTime(3600 + 5 * 60 + 7)).toBe('1:05:07');
    expect(formatRunTime(-3)).toBe('0:00');
  });
});

describe('activityLabel', () => {
  it('formats the menus, a room, solo and coop runs, and offline', () => {
    expect(activityLabel('online', { activity: { kind: 'menu' }, at: 0 }, 0)).toBe('Main Menu');
    expect(activityLabel('in_lobby', { activity: { kind: 'menu' }, at: 0 }, 0)).toBe('In a room');
    expect(activityLabel('in_game', solo(215), 1_000)).toBe('Solo • Pikachu • 3:35');
    const coop: ActivityEntry = {
      activity: { kind: 'coop', dex: 25, shiny: true, elapsedS: 3725 },
      at: 0,
    };
    expect(activityLabel('in_game', coop, 0)).toBe('Multiplayer • Pikachu • 1:02:05');
    // A prestiged Pokémon shows its stars.
    const starred: ActivityEntry = {
      activity: { kind: 'coop', dex: 25, shiny: true, elapsedS: 3725, prestige: 2 },
      at: 0,
    };
    expect(activityLabel('in_game', starred, 0)).toBe('Multiplayer • Pikachu ★★ • 1:02:05');
    expect(activityLabel('offline', undefined, 0)).toBe('Offline');
    // An older server sends no activity: the plain status.
    expect(activityLabel('in_game', undefined, 0)).toBe('Playing');
  });

  it('ticks the clock locally, and holds it while paused', () => {
    expect(runClock(solo(215), 1_000 + 10_500)).toBeCloseTo(225.5);
    expect(activityLabel('in_game', solo(215), 1_000 + 25_000)).toBe('Solo • Pikachu • 4:00');
    expect(activityLabel('in_game', solo(215, true), 1_000 + 25_000)).toBe('Solo • Pikachu • 3:35');
  });
});
