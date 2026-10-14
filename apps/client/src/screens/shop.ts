// The shop: permanent upgrades per Pokémon, bought with coins (legacy "Upgrades"). Levels and
// prices come from the server (`GET /api/upgrades`); buying returns the updated save. As in
// legacy, the "ban" upgrade opens the picker for the banned moves, and the move slots are below.
import { t, type Move, type Pokemon } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import { gameData, h, icon, num, pokemonName, replace, sprite, typeColor } from '../app/dom.js';
import { bindableMoves, movePoolOf, startingMoveOf } from '../app/moves.js';
import { toast } from '../app/toast.js';
import { loadInto, screenBox } from './common.js';

type UpgradeRules = Record<string, { maxLevel: number; baseCost: number; growth: number }>;

const BAN_UPGRADE = 'ban';
const SLOTS = 4;

// The view survives leaving and coming back, as in legacy.
let shopDex: number | null = null;
let banOpen = false;

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
    const saveMoves = (body: { bindings?: (string | null)[]; bans?: string[] }, el: HTMLElement) =>
      void app.act(null, async () => {
        el.classList.add('saving');
        try {
          app.setSave(await app.api.setMoves(dex, body));
          audio.sfx('select');
        } finally {
          render();
        }
      });
    replace(
      list,
      data.upgrades.flatMap((u) => {
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
        // With levels of "ban", a button to open the picker (none without levels, as in legacy).
        const banLevels = u.id === BAN_UPGRADE ? lvl : 0;
        const bans = s.moveBans[String(dex)] ?? [];
        const choose = banLevels
          ? h(
              'button',
              {
                class: 'btn small upg-choose',
                dataset: { testid: 'choose-bans' },
                'aria-expanded': String(banOpen),
                on: {
                  click: () => {
                    banOpen = !banOpen;
                    render();
                  },
                },
              },
              t('hud.choose', { 0: `${bans.length}/${banLevels}` }),
            )
          : null;
        const item = h(
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
            choose,
          ),
          h('div', { class: 'upg-btns' }, buy),
        );
        return banLevels && banOpen && mon
          ? [item, banPicker(mon, bans, banLevels, saveMoves)]
          : [item];
      }),
      mon ? bindPanel(mon, s.moveBindings[String(dex)] ?? [], saveMoves) : [],
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

type SaveMoves = (body: { bindings?: (string | null)[]; bans?: string[] }, el: HTMLElement) => void;

const byName = (a: Move, b: Move) => a.name.localeCompare(b.name);

/** Legacy's ban picker: tap the moves you don't want in your cards, up to one per level. */
function banPicker(mon: Pokemon, current: string[], max: number, save: SaveMoves): HTMLElement {
  const start = startingMoveOf(mon);
  const bans = new Set(current);
  const chips: HTMLElement = h(
    'div',
    { class: 'ban-moves' },
    movePoolOf(mon)
      .filter((m) => m.id !== start)
      .sort(byName)
      .map((m) =>
        h(
          'button',
          {
            class: ['chip', bans.has(m.id) && 'on ban'],
            dataset: { testid: `ban-${m.id}`, sfx: 'none' },
            'aria-pressed': String(bans.has(m.id)),
            on: {
              click: () => {
                const next = new Set(bans);
                if (next.has(m.id)) next.delete(m.id);
                else if (next.size >= max) {
                  toast(t('hud.youAlreadyHaveBannedRemove', { 0: max }), 'error');
                  return;
                } else next.add(m.id);
                save({ bans: [...next] }, chips);
              },
            },
          },
          icon(`move:${m.id}`, 16),
          ` ${m.name}`,
          bans.has(m.id) ? [' ', icon('ban', 14)] : null,
        ),
      ),
  );
  return h(
    'div',
    { class: 'panel ban-picker', dataset: { testid: 'ban-picker' } },
    h('p', { class: 'sub' }, t('hud.tapTheMovesYouDo', { 0: `${bans.size}/${max}` })),
    chips,
  );
}

/** Legacy's move shortcuts: which move always goes in each slot (keys 1-4). */
function bindPanel(mon: Pokemon, current: (string | null)[], save: SaveMoves): HTMLElement {
  const bindings = [...current];
  while (bindings.length < SLOTS) bindings.push(null);
  const options = bindableMoves(mon).sort(byName);
  const slots: HTMLElement = h(
    'div',
    { class: 'bind-slots' },
    bindings.slice(0, SLOTS).map((value, i) => {
      const select = h(
        'select',
        {
          class: 'field',
          'aria-label': `${t('hud.moveShortcuts')} ${i + 1}`,
          dataset: { testid: `bind-${i}` },
        },
        h('option', { value: '' }, t('upgrades.free')),
        options.map((m) => h('option', { value: m.id, selected: m.id === value }, m.name)),
      );
      select.addEventListener('change', () => {
        // A move goes in one slot only: picking it here frees it elsewhere, as in legacy.
        const id = select.value || null;
        const next = bindings.map((b) => (id && b === id ? null : b));
        next[i] = id;
        save({ bindings: next }, slots);
      });
      return h('label', { class: 'bind-slot' }, h('span', null, String(i + 1)), select);
    }),
  );
  return h(
    'div',
    { class: 'panel bind-panel', dataset: { testid: 'bind-panel' } },
    h('b', null, t('hud.moveShortcuts')),
    h('p', { class: 'sub' }, t('hud.chooseWhichMoveAlwaysGoes')),
    slots,
  );
}
