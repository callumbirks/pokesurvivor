import { describe, expect, it } from 'vitest';
import {
  defaultTunables,
  diffPatch,
  gameDataForRun,
  gameDataWith,
  loadGameData,
  mergePatch,
  overridesBetween,
  resolveOverrides,
  validateTunables,
  type TunableConfig,
} from '../src/index.js';

const game = loadGameData();
const defaults = defaultTunables(game);
const copy = (): TunableConfig => JSON.parse(JSON.stringify(defaults)) as TunableConfig;

describe('merge patches', () => {
  it('merges objects key by key and replaces arrays and values', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 'x' };
    expect(mergePatch(base, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] }, d: 'x' });
    expect(base.a.c).toEqual([1, 2]);
  });

  it('diffs to the smallest patch that merges back', () => {
    const changed = copy();
    changed.tuning.spawner.cap += 1;
    changed.levelup.rarity.odds = changed.levelup.rarity.odds.slice(0, 2);
    const overrides = overridesBetween(defaults, changed);
    expect(overrides).toEqual({
      tuning: { spawner: { cap: changed.tuning.spawner.cap } },
      levelup: { rarity: { odds: changed.levelup.rarity.odds } },
    });
    expect(mergePatch(defaults, overrides)).toEqual(changed);
    expect(diffPatch(defaults, copy())).toBeUndefined();
  });
});

describe('validateTunables', () => {
  it('accepts the defaults', () => {
    expect(validateTunables(game, copy()).ok).toBe(true);
  });

  it('rejects bad values with the file and path', () => {
    const bad = copy() as unknown as { tuning: { spawner: { cap: unknown } } };
    bad.tuning.spawner.cap = -3;
    const r = validateTunables(game, bad);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues).toEqual([expect.objectContaining({ file: 'tuning', path: 'spawner.cap' })]);
  });

  it('names unknown settings', () => {
    const bad = mergePatch(copy(), { levelup: { weights: { surprise: 2 } } });
    const r = validateTunables(game, bad);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues).toEqual([
        { file: 'levelup', path: 'weights.surprise', message: 'No such setting' },
      ]);
  });

  it('checks references across files', () => {
    const bad = copy();
    bad.tuning.lateGrowth.offers.statIds = ['no-such-card'];
    const r = validateTunables(game, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe('lateGrowth.offers.statIds.0');
  });
});

describe('resolveOverrides', () => {
  it('applies valid overrides as they are', () => {
    const cap = defaults.tuning.spawner.cap + 5;
    const r = resolveOverrides(game, defaults, { tuning: { spawner: { cap } } });
    expect(r.skipped).toEqual([]);
    expect(r.config.tuning.spawner.cap).toBe(cap);
    expect(r.applied).toEqual({ tuning: { spawner: { cap } } });
  });

  it('skips settings that no longer exist or no longer fit, keeping the rest', () => {
    const cap = defaults.tuning.spawner.cap + 5;
    const r = resolveOverrides(game, defaults, {
      tuning: { spawner: { cap, removedSetting: 3 }, rift: { chance: 7 } },
      levelup: { cardsOffered: defaults.levelup.cardsOffered + 1 },
      economy: { coins: 1 },
    });
    expect(r.config.tuning.spawner.cap).toBe(cap);
    expect(r.config.levelup.cardsOffered).toBe(defaults.levelup.cardsOffered + 1);
    expect(r.config.tuning.rift.chance).toBe(defaults.tuning.rift.chance);
    expect(r.skipped.map((s) => `${s.file}:${s.path}`).sort()).toEqual([
      'economy:',
      'tuning:rift.chance',
      'tuning:spawner.removedSetting',
    ]);
    expect(validateTunables(game, r.config).ok).toBe(true);
  });

  it('never throws on garbage', () => {
    for (const junk of [null, 3, 'x', [1], { tuning: 4 }, { tuning: { spawner: null } }]) {
      const r = resolveOverrides(game, defaults, junk);
      expect(r.config).toEqual(defaults);
    }
  });
});

describe('game data per config', () => {
  it('shares the defaults object when nothing changes', () => {
    expect(gameDataWith(game, copy())).toBe(game);
    expect(gameDataForRun(game, copy()).game).toBe(game);
  });

  it('replaces only the tunable files and their lookups', () => {
    const changed = copy();
    const card = changed.levelup.statCards[0]!;
    card.name = `${card.name}!`;
    const data = gameDataWith(game, changed);
    expect(data).not.toBe(game);
    expect(data.statCardById.get(card.id)?.name).toBe(card.name);
    expect(game.statCardById.get(card.id)?.name).not.toBe(card.name);
    expect(data.moveById).toBe(game.moveById);
  });
});
