// The collection (legacy "Pokémon" screen): generation tabs, filters, the grid, and a detail
// panel to choose the partner (normal or shiny) and set its move slots and banned moves.
import { t, type Pokemon } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import {
  gameData,
  boxFor,
  h,
  icon,
  rarityInfo,
  replace,
  sprite,
  rarityBall,
  typeChip,
  typeColor,
} from '../app/dom.js';
import { bindableMoves, movePoolOf, startingMoveOf } from '../app/moves.js';
import { toast } from '../app/toast.js';
import { screenBox } from './common.js';

type Filter = 'all' | 'owned' | 'missing' | 'shiny' | '1' | '2' | '3' | '4' | '5';
const BAN_UPGRADE = 'ban';
const SLOTS = 4;

// The view survives leaving and coming back, as in legacy.
let gen = 0;
let filter: Filter = 'all';
let selected = 0;
let viewShiny = false;
let movesOpen = false;

export function collectionScreen(app: App, params: URLSearchParams): Screen {
  const data = gameData();
  const banners = data.gacha.banners;
  const box = screenBox(app, { id: 'collection', title: t('menu.pokemon') });
  const total = h('span', { class: 'sub count' });
  box.header.querySelector('h2')?.append(' ', total);
  const genTabs = h('div', { class: 'gen-tabs' });
  const filters = h('div', { class: 'filters' });
  const grid = h('div', { class: 'grid', dataset: { testid: 'collection-grid' } });
  const detail = h('div', { class: 'panel detail', dataset: { testid: 'collection-detail' } });
  box.body.append(
    genTabs,
    h('div', { class: 'split' }, h('div', { class: 'grid-col' }, filters, grid), detail),
  );

  const fromParam = Number(params.get('dex'));
  if (fromParam && data.pokemonByDex.has(fromParam)) selected = fromParam;
  if (!selected) selected = app.save?.partner.dex ?? 1;
  if (!gen || fromParam) gen = data.pokemonByDex.get(selected)?.gen ?? 1;

  const owns = (dex: number) => !!app.save?.owned[String(dex)];
  const ownsShiny = (dex: number) => !!app.save?.shiny[String(dex)];

  const render = () => {
    const s = app.save;
    if (!s) return;
    total.textContent = `${Object.keys(s.owned).length} / ${data.pokedex.length}`;
    replace(
      genTabs,
      banners.map((b) => {
        const all = data.pokedex.filter((p) => p.gen === b.gen);
        return h(
          'button',
          {
            class: ['gen-tab', b.gen === gen && 'on'],
            on: {
              click: () => {
                gen = b.gen;
                render();
              },
            },
          },
          h('b', null, b.name),
          h('small', null, `${all.filter((p) => owns(p.dex)).length}/${all.length}`),
        );
      }),
    );
    const chips: { id: Filter; label: string | Node }[] = [
      { id: 'all', label: t('collection.all') },
      { id: 'owned', label: t('collection.owned') },
      { id: 'missing', label: t('collection.missing') },
      { id: 'shiny', label: `✦ ${t('app.shiny')}` },
      ...([5, 4, 3, 2, 1] as const).map((r) => ({
        id: String(r) as Filter,
        label: rarityInfo(r).name,
      })),
    ];
    replace(
      filters,
      chips.map((c) =>
        h(
          'button',
          {
            class: ['chip', c.id === filter && 'on'],
            on: {
              click: () => {
                filter = c.id;
                render();
              },
            },
          },
          c.label,
        ),
      ),
    );
    renderGrid();
    renderDetail();
  };

  const renderGrid = () => {
    const s = app.save;
    if (!s) return;
    const mons = data.pokedex.filter((p) => {
      if (p.gen !== gen) return false;
      if (filter === 'owned') return owns(p.dex);
      if (filter === 'missing') return !owns(p.dex);
      if (filter === 'shiny') return ownsShiny(p.dex);
      if (filter !== 'all') return p.rarity === Number(filter);
      return true;
    });
    replace(
      grid,
      mons.length
        ? mons.map((p) => {
            const own = owns(p.dex);
            const isPartner = p.dex === s.partner.dex;
            return h(
              'button',
              {
                class: ['cell', !own && 'locked', p.dex === selected && 'on'],
                dataset: { testid: `dex-${p.dex}` },
                on: {
                  click: () => {
                    selected = p.dex;
                    viewShiny = isPartner && s.partner.shiny && ownsShiny(p.dex);
                    for (const c of grid.querySelectorAll('.cell'))
                      c.classList.toggle('on', c.getAttribute('data-testid') === `dex-${p.dex}`);
                    renderDetail();
                  },
                },
              },
              h('span', { class: 'no' }, String(p.dex).padStart(3, '0')),
              isPartner
                ? h(
                    'span',
                    { class: 'badge-r', title: t('collection.itSYourPartner') },
                    icon('crown', 14),
                  )
                : ownsShiny(p.dex)
                  ? h('span', { class: 'badge-r' }, icon('shiny', 12))
                  : null,
              h(
                'span',
                { class: 'cell-stage' },
                sprite(p.dex, {
                  scale: 1.5,
                  silhouette: !own,
                  shiny: isPartner && s.partner.shiny && ownsShiny(p.dex),
                  fit: { width: 80, height: 58 },
                  feet: true,
                }),
              ),
              h('b', null, own ? p.name : '???'),
              rarityBall(p.rarity, 12),
            );
          })
        : h('p', { class: 'sub', style: 'grid-column:1/-1' }, t('collection.noneWithThisFilter')),
    );
  };

  const renderDetail = () => {
    const s = app.save;
    const p = data.pokemonByDex.get(selected);
    if (!s || !p) return;
    const own = owns(p.dex);
    const hasShiny = ownsShiny(p.dex);
    if (!hasShiny) viewShiny = false;
    const isPartner = p.dex === s.partner.dex;
    const usingThis = isPartner && (!hasShiny || s.partner.shiny === viewShiny);
    const banner = banners.find((b) => b.gen === p.gen);
    const bar = (label: string, v: number, max: number, text: string) =>
      h(
        'div',
        { class: 'stat' },
        h('span', null, label),
        h(
          'div',
          { class: 'bar' },
          h('i', { style: { width: `${Math.min(100, (v / max) * 100)}%` } }),
        ),
        h('span', null, text),
      );
    const pick = h(
      'button',
      {
        class: 'btn gold wide-btn',
        disabled: usingThis,
        dataset: { testid: 'choose-partner', sfx: 'none' },
      },
      usingThis
        ? t('collection.itSYourPartner')
        : t('collection.chooseAsPartner', { 0: viewShiny ? ` (${t('app.shiny')})` : '' }),
    );
    pick.addEventListener('click', () => {
      void app.act(pick, async () => {
        app.setSave(await app.api.setPartner(p.dex, viewShiny));
        audio.sfx('confirm');
        toast(
          t(viewShiny ? 'collection.shinyIsNowYourPartner' : 'collection.isNowYourPartner', {
            0: p.name,
          }),
          'good',
        );
        renderGrid();
        renderDetail();
      });
    });
    const shown = own && viewShiny;
    replace(
      detail,
      h(
        'div',
        {
          class: ['stage', shown && 'shiny'],
          style: {
            '--stage-c': !own ? '#5b83d6' : shown ? '#9ae6ff' : typeColor(p.types[0] ?? 'normal'),
          },
        },
        sprite(p.dex, {
          scale: 3,
          lively: own,
          silhouette: !own,
          shiny: shown,
          fit: boxFor({ width: 216, height: 150 }, { width: 130, height: 96 }),
          feet: true,
        }),
      ),
      hasShiny
        ? h(
            'div',
            { class: 'seg' },
            h(
              'button',
              {
                class: !viewShiny ? 'on' : undefined,
                on: { click: () => ((viewShiny = false), renderDetail()) },
              },
              t('app.normal'),
            ),
            h(
              'button',
              {
                class: viewShiny ? 'on' : undefined,
                dataset: { testid: 'view-shiny' },
                on: { click: () => ((viewShiny = true), renderDetail()) },
              },
              `✦ ${t('app.shiny')}`,
            ),
          )
        : null,
      h(
        'div',
        { class: 'center' },
        h(
          'div',
          { class: 'muted small' },
          `#${String(p.dex).padStart(3, '0')} · ${banner?.name ?? ''}`,
        ),
        h('h3', null, own ? p.name : '???'),
        h(
          'div',
          { style: { color: rarityInfo(p.rarity).color } },
          rarityBall(p.rarity, 24),
          ' ',
          rarityInfo(p.rarity).name,
        ),
        own ? h('div', { style: 'margin:6px 0' }, p.types.map(typeChip)) : null,
      ),
      own
        ? [
            bar(t('collection.hp'), p.hp, 183, String(p.hp)),
            bar(t('collection.attack'), p.attack, 1.55, `×${p.attack.toFixed(2)}`),
            bar(t('collection.speed'), p.speed, 137, String(p.speed)),
            h(
              'p',
              { class: 'small' },
              `${t('collection.startsWith')} `,
              h('b', { class: 'gold' }, data.moveById.get(startingMoveOf(p))?.name ?? ''),
            ),
            h(
              'p',
              { class: 'move-icons', title: t('app.learnableMoves') },
              movePoolOf(p).map((m) => h('span', { title: m.name }, icon(`move:${m.id}`, 16))),
            ),
            pick,
            moveSettings(app, p, () => renderDetail()),
          ]
        : h(
            'p',
            { class: 'center muted' },
            t('collection.youDonTHaveIt'),
            h('br'),
            `${t('collection.getItFromTheBanner')} `,
            h('b', { class: 'gold' }, banner?.name ?? ''),
          ),
    );
  };

  render();
  const off = app.events.on('save', () => renderGrid());
  return { el: box.el, destroy: off };
}

/** Move slots ("shortcuts") and bans for an owned Pokémon (legacy upgrades panel). */
function moveSettings(app: App, p: Pokemon, rerender: () => void): HTMLElement {
  const data = gameData();
  const s = app.save;
  if (!s) return h('div');
  const key = String(p.dex);
  const bindings = [...(s.moveBindings[key] ?? [])];
  while (bindings.length < SLOTS) bindings.push(null);
  const bans = new Set(s.moveBans[key] ?? []);
  const maxBans = s.upgrades[key]?.[BAN_UPGRADE] ?? 0;
  const start = startingMoveOf(p);
  const options = bindableMoves(p);

  const save = (body: { bindings?: (string | null)[]; bans?: string[] }, el: HTMLElement) =>
    void app.act(null, async () => {
      el.classList.add('saving');
      try {
        app.setSave(await app.api.setMoves(p.dex, body));
      } finally {
        rerender();
      }
    });

  const slots = h(
    'div',
    { class: 'bind-slots' },
    bindings.map((current, i) => {
      const select = h(
        'select',
        {
          class: 'field',
          'aria-label': `${t('hud.moveShortcuts')} ${i + 1}`,
          dataset: { testid: `bind-${i}` },
        },
        h('option', { value: '' }, '—'),
        options.map((m) =>
          h(
            'option',
            {
              value: m.id,
              selected: m.id === current,
              // Each move once: taken in another slot.
              disabled: bindings.some((b, k) => k !== i && b === m.id),
            },
            m.name,
          ),
        ),
      );
      select.addEventListener('change', () => {
        const next = [...bindings];
        next[i] = select.value || null;
        save({ bindings: next }, slots);
      });
      return h('label', { class: 'bind-slot' }, h('span', null, String(i + 1)), select);
    }),
  );

  const banChips = h(
    'div',
    { class: 'ban-moves' },
    movePoolOf(p)
      .filter((m) => m.id !== start)
      .map((m) =>
        h(
          'button',
          {
            class: ['chip', bans.has(m.id) && 'ban'],
            dataset: { testid: `ban-${m.id}`, sfx: 'select' },
            disabled: maxBans === 0,
            on: {
              click: () => {
                const next = new Set(bans);
                if (next.has(m.id)) next.delete(m.id);
                else {
                  if (next.size >= maxBans) {
                    toast(t('hud.youAlreadyHaveBannedRemove', { 0: maxBans }), 'error');
                    return;
                  }
                  next.add(m.id);
                }
                save({ bans: [...next] }, banChips);
              },
            },
          },
          icon(`move:${m.id}`, 16),
          ` ${m.name}`,
          bans.has(m.id) ? [' ', icon('ban', 14)] : null,
        ),
      ),
  );

  const details = h(
    'details',
    { class: 'move-settings', open: movesOpen },
    h('summary', null, t('hud.moveShortcuts')),
    h('p', { class: 'small muted' }, t('hud.chooseWhichMoveAlwaysGoes')),
    slots,
    h('h4', null, t('app.bannedMoves', { 0: bans.size, 1: maxBans })),
    h(
      'p',
      { class: 'small muted' },
      maxBans
        ? t('hud.tapTheMovesYouDo', { 0: maxBans })
        : t('app.banNeedsUpgrade', { 0: data.upgradeById.get(BAN_UPGRADE)?.name ?? BAN_UPGRADE }),
    ),
    banChips,
  );
  details.addEventListener('toggle', () => (movesOpen = details.open));
  return details;
}
