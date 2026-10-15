// The collection (legacy "Pokémon" screen): generation tabs, filters, the grid, and a detail
// panel to choose the partner (normal or shiny). Move slots and bans are in the shop, as in legacy.
import { t } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import { gameData, h, replace } from '../app/dom.js';
import { filterPokemon } from '../app/pokemon-filter.js';
import {
  chip,
  markCell,
  pokemonCell,
  pokemonDetail,
  RARITIES,
  rarityChipLabel,
  regionTabs,
  shinyChipLabel,
} from '../app/pokemon-views.js';
import { toast } from '../app/toast.js';
import { screenBox } from './common.js';
import { prestigeOf } from '../app/prestige.js';

type Filter = 'all' | 'owned' | 'missing' | 'shiny' | '1' | '2' | '3' | '4' | '5';

// The view survives leaving and coming back, as in legacy.
let gen = 0;
let filter: Filter = 'all';
let selected = 0;
let viewShiny = false;

export function collectionScreen(app: App, params: URLSearchParams): Screen {
  const data = gameData();
  const banners = data.gacha.banners;
  const box = screenBox(app, { id: 'collection', title: t('menu.pokemon') });
  const total = h('span', { class: 'title-tag', dataset: { testid: 'collection-count' } });
  box.title.after(total);
  const genTabs = h('div', { class: 'gen-tabs', dataset: { navRow: '' } });
  const filters = h('div', { class: 'filters', dataset: { navRow: '' } });
  const grid = h('div', { class: 'grid', dataset: { testid: 'collection-grid', navGrid: '' } });
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
      regionTabs(
        gen,
        (g) => {
          gen = g;
          render();
        },
        (g) => {
          const all = data.pokedex.filter((p) => p.gen === g);
          return `${all.filter((p) => owns(p.dex)).length}/${all.length}`;
        },
      ),
    );
    const chips: { id: Filter; label: string | Node }[] = [
      { id: 'all', label: t('collection.all') },
      { id: 'owned', label: t('collection.owned') },
      { id: 'missing', label: t('collection.missing') },
      // As legacy: the shiny icon, and each rarity's Poké Ball.
      { id: 'shiny', label: shinyChipLabel() },
      ...RARITIES.map((r) => ({ id: String(r) as Filter, label: rarityChipLabel(r) })),
    ];
    replace(
      filters,
      chips.map((c) =>
        chip(
          c.label,
          c.id === filter,
          () => {
            filter = c.id;
            render();
          },
          `filter-${c.id}`,
        ),
      ),
    );
    renderGrid();
    renderDetail();
  };

  const renderGrid = () => {
    const s = app.save;
    if (!s) return;
    const mons = filterPokemon(
      data.pokedex,
      {
        gen,
        shiny: filter === 'shiny',
        rarity: /^\d$/.test(filter) ? Number(filter) : 0,
      },
      s,
      (dex) => data.pokemonByDex.get(dex)?.name ?? '',
    ).filter((p) =>
      filter === 'owned' ? owns(p.dex) : filter === 'missing' ? !owns(p.dex) : true,
    );
    replace(
      grid,
      mons.length
        ? mons.map((p) => {
            const isPartner = p.dex === s.partner.dex;
            const shinyPartner = isPartner && s.partner.shiny && ownsShiny(p.dex);
            return pokemonCell(p, {
              testid: `dex-${p.dex}`,
              own: owns(p.dex),
              selected: p.dex === selected,
              partner: isPartner,
              hasShiny: ownsShiny(p.dex),
              prestige: prestigeOf(s, p.dex),
              shiny: shinyPartner,
              onClick: () => {
                selected = p.dex;
                viewShiny = shinyPartner;
                markCell(grid, p.dex);
                renderDetail();
              },
            });
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
    const pick = h(
      'button',
      {
        class: 'btn primary wide-btn',
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
    replace(
      detail,
      pokemonDetail(p, {
        own,
        hasShiny,
        viewShiny,
        prestige: prestigeOf(s, p.dex),
        onShiny: (shiny) => {
          viewShiny = shiny;
          renderDetail();
        },
      }),
      own
        ? pick
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
