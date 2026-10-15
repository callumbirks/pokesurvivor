// Pokémon prestige on screen: the gold stars next to a Pokémon wherever it appears, and the % chips
// of what its stars add. The server decides eligibility and the sim applies the bonus; these only
// read the stars from the save (or a message) and the per-star values from the tuning.
import { clampStars, prestigeBonus, t } from '@pokesurvivor/data';
import type { Save } from './api.js';
import { gameData, h } from './dom.js';

/** The stars of `dex` in a save (0 when it has none). */
export function prestigeOf(save: Pick<Save, 'prestige'> | null | undefined, dex: number): number {
  return clampStars(gameData().tuning.prestige, save?.prestige?.[String(dex)]);
}

/** `★★` for 2 stars, in gold, with "Prestige 2" for screen readers; null without stars. */
export function stars(n: number | undefined, cls?: string): HTMLElement | null {
  const count = clampStars(gameData().tuning.prestige, n);
  if (!count) return null;
  const label = t('prestige.stars', { 0: count });
  return h(
    'span',
    {
      class: ['stars', cls],
      title: label,
      'aria-label': label,
      role: 'img',
      dataset: { testid: 'stars', stars: String(count) },
    },
    '★'.repeat(count),
  );
}

/** Whole percent, e.g. 0.1 → 10. */
const pct = (v: number) => Math.round(v * 100);

/** What `n` stars add, as lines ("+10% HP", …), in the order of the tuning. */
export function prestigeGains(n: number): { id: string; text: string }[] {
  const b = prestigeBonus(gameData().tuning.prestige, n);
  return [
    { id: 'hp', text: t('prestige.hp', { 0: pct(b.hpMul - 1) }) },
    { id: 'damage', text: t('prestige.damage', { 0: pct(b.damageMul - 1) }) },
    { id: 'speed', text: t('prestige.speed', { 0: pct(b.speedMul - 1) }) },
    { id: 'cooldown', text: t('prestige.cooldown', { 0: pct(1 - b.cooldownMul) }) },
    { id: 'defense', text: t('prestige.defense', { 0: pct(b.defense) }) },
    { id: 'crit', text: t('prestige.crit', { 0: pct(b.crit) }) },
  ].filter((g) => !/[+−]0%/.test(g.text));
}

/**
 * The "Prestige ★★" box of the detail panels: chips for the stats that are the same for every
 * Pokémon (cooldown, defence, crit); HP, attack and speed show on their bars. Null at 0.
 */
export function prestigeBox(n: number): HTMLElement | null {
  const star = stars(n);
  if (!star) return null;
  const flat = prestigeGains(n).filter((g) => !['hp', 'damage', 'speed'].includes(g.id));
  return h(
    'div',
    { class: 'prestige-box', dataset: { testid: 'prestige-box' } },
    h('h4', null, `${t('prestige.title')} `, star),
    h(
      'div',
      { class: 'chips' },
      flat.map((g) => h('span', { class: 'chip prestige-chip' }, g.text)),
    ),
  );
}
