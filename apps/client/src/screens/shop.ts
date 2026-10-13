// The shop: permanent upgrades per Pokémon, bought with coins (legacy "Upgrades"). Levels and
// prices come from the server (`GET /api/upgrades`); buying returns the updated save.
import { t } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import { gameData, h, icon, num, pokemonName, replace, sprite, typeColor } from '../app/dom.js';
import { loadInto, screenBox } from './common.js';

type UpgradeRules = Record<string, { maxLevel: number; baseCost: number; growth: number }>;

let shopDex: number | null = null;

/** The price shown for level `level + 1` (the server charges the same, `docs/api.md`). */
export function upgradeCost(rule: { baseCost: number; growth: number }, level: number): number {
  return Math.round((rule.baseCost * rule.growth ** level) / 10) * 10;
}

let rulesCache: Promise<UpgradeRules> | null = null;

export function shopScreen(app: App): Screen {
  const data = gameData();
  const box = screenBox(app, { id: 'shop', title: t('menu.upgrades') });
  const head = h('div', { class: 'upg-head' });
  const list = h('div', { class: 'upg', dataset: { testid: 'upgrades' } });
  let rules: UpgradeRules = {};

  const levelsOf = (dex: number) => app.save?.upgrades[String(dex)] ?? {};
  const totalLevels = (dex: number) => Object.values(levelsOf(dex)).reduce((a, b) => a + b, 0);

  const render = () => {
    const s = app.save;
    if (!s) return;
    const partner = s.partner.dex;
    const owned = Object.keys(s.owned)
      .map(Number)
      .filter((d) => data.pokemonByDex.has(d))
      .sort(
        (a, b) =>
          Number(b === partner) - Number(a === partner) || totalLevels(b) - totalLevels(a) || a - b,
      );
    if (!shopDex || !s.owned[String(shopDex)]) shopDex = partner ?? owned[0] ?? null;
    const dex = shopDex;
    if (!dex) return;
    const mon = data.pokemonByDex.get(dex);
    const shiny = dex === partner && s.partner.shiny && !!s.shiny[String(dex)];
    const select = h(
      'select',
      { class: 'field', dataset: { testid: 'shop-pokemon' } },
      owned.map((d) =>
        h(
          'option',
          { value: String(d), selected: d === dex },
          pokemonName(d),
          d === partner ? ` (${t('app.partner')})` : '',
          totalLevels(d) ? ` · ${t('app.levels', { 0: totalLevels(d) })}` : '',
        ),
      ),
    );
    select.addEventListener('change', () => {
      shopDex = Number(select.value);
      render();
    });
    replace(
      head,
      h(
        'div',
        {
          class: ['stage', 'small', shiny && 'shiny'],
          style: { '--stage-c': shiny ? '#9ae6ff' : typeColor(mon?.types[0] ?? 'normal') },
        },
        sprite(dex, { scale: 2, lively: true, shiny, fit: { width: 110, height: 64 }, feet: true }),
      ),
      h(
        'div',
        { class: 'grow' },
        h('p', { class: 'sub' }, t('upgrades.eachPokemonHasItsOwn')),
        select,
      ),
    );
    const levels = levelsOf(dex);
    replace(
      list,
      data.upgrades.map((u) => {
        const rule = rules[u.id] ?? {
          maxLevel: u.maxLevel,
          baseCost: u.baseCost,
          growth: u.costGrowth,
        };
        const lvl = levels[u.id] ?? 0;
        const maxed = lvl >= rule.maxLevel;
        const cost = maxed ? 0 : upgradeCost(rule, lvl);
        const buy = h(
          'button',
          {
            class: ['btn', 'small', !maxed && 'gold'],
            disabled: maxed || s.coins < cost,
            dataset: { testid: `buy-${u.id}`, sfx: 'none' },
          },
          maxed ? t('upgrades.max') : [icon('coin', 18), ` ${num(cost)}`],
        );
        buy.addEventListener('click', () => {
          void app.act(buy, async () => {
            app.setSave(await app.api.buyUpgrade(dex, u.id));
            audio.sfx('buy');
          });
        });
        return h(
          'div',
          { class: 'panel upg-item' },
          h('div', { class: 'ic' }, icon(u.icon, 32)),
          h(
            'div',
            null,
            h('b', null, u.name),
            ' ',
            h('span', { class: 'muted small' }, u.description),
            h(
              'div',
              { class: 'pips' },
              Array.from({ length: rule.maxLevel }, (_, i) =>
                h('i', { class: i < lvl ? 'on' : undefined }),
              ),
            ),
          ),
          h('div', { class: 'upg-btns' }, buy),
        );
      }),
    );
  };

  loadInto(
    box.body,
    () =>
      (rulesCache ??= app.api
        .request<{ upgrades: UpgradeRules }>('GET', '/api/upgrades')
        .then((r) => r.upgrades)
        .catch((e: unknown) => {
          rulesCache = null;
          throw e;
        })),
    (r) => {
      rules = r;
      replace(box.body, head, list);
      render();
    },
  );
  const off = app.events.on('save', render);
  return { el: box.el, destroy: off };
}
