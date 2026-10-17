// The shop: permanent upgrades per Pokémon, bought with coins (legacy "Upgrades"). Levels and
// prices come from the server (`GET /api/upgrades`); buying returns the updated save. As in
// legacy, the "ban" upgrade opens the picker for the banned moves, and the move slots are below.
// Once bought, "Repertoire" has a drop-down for the second move runs start with (or random).
// Above the upgrades, the Pokémon's stats with its prestige and the Prestige button: once every
// upgrade is maxed, the server resets them for a star and gems (`POST /api/save/prestige`). Next
// to it, Reset: for gems, the server resets the upgrades and gives back the coins spent on them
// since the last prestige (`POST /api/save/upgrades/reset`; the refund is its quote).
import { canPrestige, t, type Move, type Pokemon } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import { gameData, h, icon, num, pokemonName, replace, sprite } from '../app/dom.js';
import { confirmDialog } from '../app/confirm-dialog.js';
import type { MovesBody, ResetQuote, Save } from '../app/api.js';
import { bindableMoves, movePoolOf, repertoireMoves, startingMoveOf } from '../app/moves.js';
import { statBars } from '../app/pokemon-views.js';
import { prestigeGains, prestigeOf, stars } from '../app/prestige.js';
import { shopPick, type ShopPick } from '../app/shop-pick.js';
import { toast } from '../app/toast.js';
import { loadInto, screenBox } from './common.js';

type UpgradeRules = Record<string, { maxLevel: number; baseCost: number; growth: number }>;

const BAN_UPGRADE = 'ban';
const REPERTOIRE_UPGRADE = 'extra-move';
const SLOTS = 4;

// The view survives leaving and coming back, as in legacy, until the partner changes.
let pick: ShopPick = { dex: null, partner: null };
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
  const prestigeEl = h('div', { class: 'panel prestige-panel', dataset: { testid: 'prestige' } });
  const list = h('div', { class: 'upg', dataset: { testid: 'upgrades' } });
  let rules: UpgradeRules = {};
  /** The server's reset quote per Pokémon and save version (it changes with every purchase). */
  const quotes = new Map<string, ResetQuote | 'loading'>();
  const quoteOf = (s: Save, dex: number): ResetQuote | null => {
    const key = `${dex}@${s.updatedAt}`;
    const q = quotes.get(key);
    if (q) return q === 'loading' ? null : q;
    quotes.set(key, 'loading');
    app.api.resetQuote(dex).then(
      (quote) => {
        quotes.set(key, quote);
        if (app.save === s && pick.dex === dex) render();
      },
      () => quotes.delete(key),
    );
    return null;
  };

  const levelsOf = (dex: number) => app.save?.upgrades[String(dex)] ?? {};
  const totalLevels = (dex: number) => Object.values(levelsOf(dex)).reduce((a, b) => a + b, 0);

  const render = () => {
    const s = app.save;
    if (!s) return;
    // A drop-down that saved re-renders: the keys and the pad stay on the one replacing it.
    const active = document.activeElement;
    const refocus =
      active instanceof HTMLElement && list.contains(active) ? active.dataset.testid : undefined;
    const partner = s.partner.dex;
    const owned = Object.keys(s.owned)
      .map(Number)
      .filter((d) => data.pokemonByDex.has(d))
      .sort(
        (a, b) =>
          Number(b === partner) - Number(a === partner) || totalLevels(b) - totalLevels(a) || a - b,
      );
    pick = shopPick(pick, partner, owned);
    const dex = pick.dex;
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
          prestigeOf(s, d) ? ` ${'★'.repeat(prestigeOf(s, d))}` : '',
          d === partner ? ` (${t('app.partner')})` : '',
          totalLevels(d) ? ` · ${t('app.levels', { 0: totalLevels(d) })}` : '',
        ),
      ),
    );
    select.addEventListener('change', () => {
      pick = { dex: Number(select.value), partner };
      render();
    });
    replace(
      head,
      h(
        'div',
        {
          class: ['stage', 'small', shiny && 'shiny'],
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
    if (mon) renderPrestige(mon, levels);
    const saveMoves = (body: MovesBody, el: HTMLElement) =>
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
            class: ['btn', 'small', !maxed && 'primary'],
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
        const second =
          u.id === REPERTOIRE_UPGRADE && lvl > 0 && mon
            ? repertoireSelect(mon, bans, s.repertoireMoves?.[String(dex)], saveMoves)
            : null;
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
          second,
        );
        return banLevels && banOpen && mon
          ? [item, banPicker(mon, bans, banLevels, saveMoves)]
          : [item];
      }),
      mon ? bindPanel(mon, s.moveBindings[String(dex)] ?? [], saveMoves) : [],
    );
    if (refocus)
      list.querySelector<HTMLElement>(`[data-testid="${refocus}"]`)?.focus({ preventScroll: true });
  };

  /** The stats with the prestige share, and the Prestige button with what it would do. */
  const renderPrestige = (mon: Pokemon, levels: Record<string, number>) => {
    const s = app.save;
    if (!s) return;
    const tuning = data.tuning.prestige;
    const current = prestigeOf(s, mon.dex);
    const maxLevels = Object.fromEntries(
      data.upgrades.map((u) => [u.id, rules[u.id]?.maxLevel ?? u.maxLevel]),
    );
    const ready = canPrestige(tuning, maxLevels, levels, current);
    const atMax = current >= tuning.maxStars;
    const gems = s.gems ?? 0;
    const { prestigeCost } = data.tuning.gems;
    const affordable = gems >= prestigeCost;
    const button = h(
      'button',
      {
        class: ['btn', ready && affordable && 'primary'],
        disabled: !ready || !affordable,
        dataset: { testid: 'prestige-button', sfx: 'none' },
      },
      '★ ',
      t('prestige.button'),
      ' ',
      h('span', { class: 'btn-cost' }, icon('gem', 16), ` ${num(prestigeCost)}`),
    );
    button.addEventListener('click', () => void prestige(mon, current, button));
    const quote = quoteOf(s, mon.dex);
    const refundable = !!quote && quote.refund > 0;
    const canReset = refundable && gems >= quote.cost;
    const reset = h(
      'button',
      {
        class: 'btn',
        disabled: !canReset,
        title: !quote
          ? ''
          : !refundable
            ? t('reset.nothing')
            : canReset
              ? t('reset.status', { 0: quote.cost, 1: num(quote.refund) })
              : t('reset.needGems', { 0: quote.cost, 1: gems }),
        dataset: { testid: 'reset-button', sfx: 'none', refund: String(quote?.refund ?? '') },
      },
      t('reset.button'),
      ' ',
      h(
        'span',
        { class: 'btn-cost' },
        icon('gem', 16),
        ` ${num(quote?.cost ?? data.tuning.gems.resetCost)}`,
      ),
    );
    if (quote)
      reset.addEventListener('click', () => void resetUpgrades(mon, current, quote, reset));
    replace(
      prestigeEl,
      h(
        'div',
        { class: 'prestige-head' },
        h('b', null, mon.name),
        current ? [' ', stars(current)] : null,
        h(
          'p',
          { class: 'sub', dataset: { testid: 'prestige-status' } },
          atMax
            ? t('prestige.maxed', { 0: current })
            : !ready
              ? t('prestige.notReady')
              : affordable
                ? t('prestige.ready')
                : t('prestige.needGems', { 0: prestigeCost, 1: gems }),
        ),
        h('div', { class: 'prestige-btns' }, atMax ? null : button, reset),
      ),
      h('div', { class: 'prestige-stats' }, statBars(mon, current)),
    );
  };

  const prestige = async (mon: Pokemon, current: number, button: HTMLButtonElement) => {
    const s = app.save;
    if (!s) return;
    const next = current + 1;
    const bans = s.moveBans[String(mon.dex)] ?? [];
    const ok = await confirmDialog({
      testid: 'prestige-dialog',
      title: t('prestige.confirmTitle', { 0: mon.name }),
      body: [
        h('h4', null, t('prestige.resets')),
        h(
          'ul',
          { class: 'dialog-list' },
          h('li', null, t('prestige.resetUpgrades', { 0: data.upgrades.length })),
          bans.length ? h('li', null, t('prestige.resetBans')) : null,
          s.repertoireMoves?.[String(mon.dex)]
            ? h('li', null, t('prestige.resetRepertoire'))
            : null,
          h('li', { class: 'muted' }, t('prestige.keeps')),
        ),
        h(
          'p',
          { class: 'dialog-cost', dataset: { testid: 'prestige-cost' } },
          icon('gem', 18),
          ' ',
          t('prestige.cost', { 0: data.tuning.gems.prestigeCost, 1: s.gems ?? 0 }),
        ),
        h('h4', null, t('prestige.gain'), ' ', stars(next)),
        h('p', { class: 'sub' }, t('prestige.gainStar', { 0: next })),
        h(
          'div',
          { class: 'chips', dataset: { testid: 'prestige-gains' } },
          prestigeGains(next).map((g) => h('span', { class: 'chip prestige-chip' }, g.text)),
        ),
      ],
      confirmLabel: t('prestige.confirm'),
      cancelLabel: t('prestige.cancel'),
    });
    if (!ok) return;
    await app.act(button, async () => {
      app.setSave(await app.api.prestige(mon.dex));
      audio.sfx('buy');
      toast(t('prestige.done', { 0: mon.name, 1: next }), 'good');
    });
  };

  /** The confirm dialog of a reset: what goes, the exact refund, the gem cost, and that stars stay. */
  const resetUpgrades = async (
    mon: Pokemon,
    current: number,
    quote: ResetQuote,
    button: HTMLButtonElement,
  ) => {
    const s = app.save;
    if (!s) return;
    const key = String(mon.dex);
    const star = stars(current);
    const ok = await confirmDialog({
      testid: 'reset-dialog',
      title: t('reset.confirmTitle', { 0: mon.name }),
      body: [
        h('p', { class: 'dialog-warning' }, t('reset.warning')),
        h('h4', null, t('reset.resets')),
        h(
          'ul',
          { class: 'dialog-list' },
          h('li', null, t('reset.resetUpgrades')),
          s.moveBans[key]?.length ? h('li', null, t('reset.resetBans')) : null,
          s.repertoireMoves?.[key] ? h('li', null, t('reset.resetRepertoire')) : null,
          h(
            'li',
            { class: 'muted', dataset: { testid: 'reset-keeps' } },
            current ? [t('reset.keepsStars', { 0: current }), ' ', star] : t('prestige.keeps'),
          ),
        ),
        h('h4', null, t('reset.refund')),
        h(
          'p',
          { class: 'gold', dataset: { testid: 'reset-refund' } },
          icon('coin', 18),
          ' ',
          t('reset.refundCoins', { 0: num(quote.refund) }),
        ),
        quote.unrecorded > 0
          ? h(
              'p',
              { class: 'sub', dataset: { testid: 'reset-unrecorded' } },
              t('reset.refundUnrecorded', { 0: num(quote.unrecorded) }),
            )
          : null,
        h(
          'p',
          { class: 'dialog-cost', dataset: { testid: 'reset-cost' } },
          icon('gem', 18),
          ' ',
          t('reset.cost', { 0: quote.cost, 1: s.gems ?? 0 }),
        ),
      ],
      confirmLabel: t('reset.confirm', { 0: quote.cost }),
      cancelLabel: t('reset.cancel'),
    });
    if (!ok) return;
    await app.act(button, async () => {
      app.setSave(await app.api.resetUpgrades(mon.dex));
      audio.sfx('buy');
      toast(t('reset.done', { 0: mon.name, 1: num(quote.refund) }), 'good');
    });
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
      replace(box.body, head, prestigeEl, list);
      render();
    },
  );
  const off = app.events.on('save', render);
  return { el: box.el, destroy: off };
}

type SaveMoves = (body: MovesBody, el: HTMLElement) => void;

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

/**
 * Repertoire's second starting move: Random (the default, as before) or one of the moves it could
 * roll, with its type. A choice that is no longer valid (banned since) shows as Random.
 */
function repertoireSelect(
  mon: Pokemon,
  bans: string[],
  current: string | undefined,
  save: SaveMoves,
): HTMLElement {
  const types = gameData().types.types;
  const typeName = (id: string) => types.find((x) => x.id === id)?.name ?? id;
  const options = repertoireMoves(mon, bans).sort(byName);
  const select = h(
    'select',
    {
      class: 'field',
      'aria-label': t('upgrades.secondMove'),
      dataset: { testid: 'repertoire-move' },
    },
    h('option', { value: '' }, t('upgrades.random')),
    options.map((m) =>
      h('option', { value: m.id }, t('upgrades.moveOption', { 0: m.name, 1: typeName(m.type) })),
    ),
  );
  select.value = options.some((m) => m.id === current) ? (current ?? '') : '';
  select.addEventListener('change', () => save({ repertoire: select.value || null }, select));
  return h(
    'label',
    { class: 'upg-repertoire' },
    h('span', { class: 'muted small' }, t('upgrades.secondMove')),
    select,
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
