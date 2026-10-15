import { defaultTunables, loadGameData, mergePatch, type TunableConfig } from '@pokesurvivor/data';
import { describe, expect, it } from 'vitest';
import { configChanges, jsonErrorOffset, parseJson, showValue } from './config-diff.js';

const defaults = defaultTunables(loadGameData());

describe('configChanges', () => {
  it('lists each changed setting with its old and new value', () => {
    const cap = defaults.tuning.spawner.cap + 1;
    const odds = defaults.levelup.rarity.odds.slice(0, 2);
    const next = mergePatch(defaults, {
      tuning: { spawner: { cap } },
      levelup: { rarity: { odds } },
    }) as TunableConfig;
    expect(configChanges(defaults, next)).toEqual([
      { file: 'tuning', path: 'spawner.cap', from: defaults.tuning.spawner.cap, to: cap },
      { file: 'levelup', path: 'rarity.odds', from: defaults.levelup.rarity.odds, to: odds },
    ]);
    expect(configChanges(defaults, defaults)).toEqual([]);
  });

  it('shows values on one line', () => {
    expect(showValue([1, { a: 2 }])).toBe('[1,{"a":2}]');
    expect(showValue(undefined)).toBe('—');
  });
});

describe('parseJson', () => {
  it('parses, or says where it failed', () => {
    expect(parseJson('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    const r = parseJson('{\n  "a": 1,\n  "b": }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/line 3/);
  });
});

describe('jsonErrorOffset', () => {
  it('finds the first character that breaks the JSON', () => {
    expect(jsonErrorOffset('{"a": [1, 2.5e3, "x\\"y", true, null]}')).toBe(-1);
    expect(jsonErrorOffset('{"a": 1,}')).toBe(8);
    expect(jsonErrorOffset('{"a": 01}')).toBe(7);
    expect(jsonErrorOffset('[1, 2] x')).toBe(7);
    expect(jsonErrorOffset('{"a": tru}')).toBe(6);
  });
});
