import { t } from '@pokesurvivor/data';
import type { SelfStats } from '@pokesurvivor/netclient';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import { statRows, visibleStatRows } from './stats-panel.js';

const base: SelfStats = {
  attackBase: 1.03,
  attack: 1.03,
  speedBase: 105,
  speed: 105,
  hpBase: 88,
  maxHp: 88,
  cooldown: 1,
  damageReduction: 0,
  regen: 0,
  magnet: 1,
  xp: 1,
  crit: 0,
};
const cells = (s: SelfStats, momentum = 1) =>
  Object.fromEntries(
    statRows(s, momentum)
      .flat()
      .map((c) => [c.label, c]),
  );

describe('stats panel', () => {
  it('shows attack, speed and HP with everything applied, and the multiplier over the base', () => {
    const c = cells({ ...base, attack: 1.03 * 1.45, speed: 126, maxHp: 132 });
    expect(c[t('hud.statAtk')]).toMatchObject({ value: '149', mult: '×1.45', changed: true });
    expect(c[t('hud.statSpe')]).toMatchObject({ value: '126', mult: '×1.20', changed: true });
    expect(c[t('hud.statHp')]).toMatchObject({ value: '132', mult: '×1.50', changed: true });
  });

  it('multiplies Momentum into attack', () => {
    const c = cells({ ...base, attack: 1.03 * 1.2 }, 1.5);
    expect(c[t('hud.statAtk')]).toMatchObject({
      value: String(Math.round(103 * 1.8)),
      mult: '×1.80',
    });
  });

  it('shows the stats without a base as their multiplier or amount', () => {
    const c = cells({
      ...base,
      cooldown: 0.78,
      damageReduction: 0.16,
      regen: 1.8,
      magnet: 1.44,
      xp: 1.17,
    });
    expect(c[t('hud.statCooldown')]).toMatchObject({ value: '', mult: '×0.78', changed: true });
    expect(c[t('hud.statDefense')]).toMatchObject({ value: '16%', changed: true });
    expect(c[t('hud.statRegen')]).toMatchObject({ value: '+1.8/s', changed: true });
    expect(c[t('hud.statMagnet')]).toMatchObject({ mult: '×1.44' });
    expect(c[t('hud.statXp')]).toMatchObject({ mult: '×1.17' });
  });

  it('marks nothing as changed at the base, and hides crit until there is some', () => {
    const c = cells(base);
    expect(Object.values(c).some((x) => x.changed)).toBe(false);
    expect(c[t('hud.statAtk')]).toMatchObject({ value: '103', mult: '×1.00' });
    expect(c[t('hud.statCrit')]).toBeUndefined();
    expect(cells({ ...base, crit: 0.05 })[t('hud.statCrit')]).toMatchObject({ value: '5%' });
  });

  it('is on by default, and shows only with the setting on and stats received', () => {
    expect(DEFAULT_SETTINGS.showStats).toBe(true);
    expect(visibleStatRows(true, base, 1)).toEqual(statRows(base, 1));
    expect(visibleStatRows(false, base, 1)).toBeNull();
    expect(visibleStatRows(true, null, 1)).toBeNull();
    expect(visibleStatRows(true, undefined, 1)).toBeNull();
  });
});
