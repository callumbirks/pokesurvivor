// The Pokémon picker (solo and the room): search as you type, filters (region, type, rarity,
// shiny), sort, a grid of the owned Pokémon and the selected one's details with a confirm button.
//   const picker = pokemonPicker(app, { id: 'solo', confirm: … });
//   screen.append(picker.el); … picker.refresh() (the room changed); picker.destroy()
// It starts on the player's partner. The grid's selection follows the focus, so the keys and the
// gamepad move it; A (or Enter) on a cell goes on to the confirm button. Enter or ↓ in the search
// field goes to the first result; Esc leaves the field (menu-nav), and B goes back as usual.
// On short screens (phones in landscape) the filters fold behind a button and the confirm button
// stays below the details, which scroll.
import { t, type Pokemon, type UiStringKey } from '@pokesurvivor/data';
import type { App } from './app.js';
import { gameData, h, pokemonName, replace, typeChip } from './dom.js';
import {
  activeFilters,
  filterPokemon,
  NO_FILTER,
  POKEMON_SORTS,
  sortPokemon,
  upgradeLevel,
  type PokemonFilter,
  type PokemonSort,
} from './pokemon-filter.js';
import {
  chip,
  markCell,
  pokemonCell,
  pokemonDetail,
  RARITIES,
  rarityChipLabel,
  regionTabs,
  shinyChipLabel,
} from './pokemon-views.js';

const SORT_LABEL: Record<PokemonSort, UiStringKey> = {
  dex: 'picker.sortDex',
  name: 'picker.sortName',
  upgrades: 'picker.sortUpgrades',
  rarity: 'picker.sortRarity',
  newest: 'picker.sortNewest',
};

// The sort survives closing the picker (both pickers share it); the search and filters don't.
let sort: PokemonSort = 'dex';

export interface PickerConfirm {
  /** The confirm button's label for the selection. */
  label: (p: Pokemon, shiny: boolean, isPartner: boolean) => string;
  /** Why the button is off (shown under it), or null. `''`: off without a note. */
  blocked?: (p: Pokemon, shiny: boolean, isPartner: boolean) => string | null;
  /** The button was pressed (`button` for `app.act`). */
  onConfirm: (p: Pokemon, shiny: boolean, button: HTMLButtonElement) => void;
  /** A larger button (solo's Play). */
  big?: boolean;
  /** The button's test id (default `<id>-confirm`). */
  testid?: string;
}

export interface PokemonPicker {
  el: HTMLElement;
  /** Re-checks the confirm button (the room changed, say). */
  refresh(): void;
  destroy(): void;
}

export function pokemonPicker(
  app: App,
  opts: { id: string; confirm: PickerConfirm },
): PokemonPicker {
  const data = gameData();
  const id = opts.id;
  const filter: PokemonFilter = { ...NO_FILTER };
  let selected = app.save?.partner.dex ?? 0;
  let viewShiny = !!app.save?.partner.shiny;
  let filtersOpen = false;

  const owns = (dex: number) => !!app.save?.owned[String(dex)];
  const ownsShiny = (dex: number) => !!app.save?.shiny[String(dex)];
  const ownedMons = () => data.pokedex.filter((p) => owns(p.dex));

  const search = h('input', {
    class: 'field picker-search',
    type: 'search',
    placeholder: t('picker.search'),
    'aria-label': t('picker.searchLabel'),
    autocomplete: 'off',
    spellcheck: false,
    dataset: { testid: `${id}-search` },
  });
  const sortBtn = h('button', {
    class: 'btn small ghost picker-sort',
    dataset: { testid: `${id}-sort` },
  });
  const filtersBtn = h('button', {
    class: 'btn small ghost picker-filters-btn',
    'aria-expanded': 'false',
    dataset: { testid: `${id}-filters` },
  });
  const count = h('span', { class: 'picker-count muted', dataset: { testid: `${id}-count` } });
  const regions = h('div', { class: 'gen-tabs' });
  const chips = h('div', { class: 'filters picker-chips' });
  const types = h('div', { class: 'filters picker-types' });
  const filters = h('div', { class: 'picker-filters' }, regions, chips, types);
  const grid = h('div', { class: 'grid', dataset: { testid: `${id}-grid` } });
  const info = h('div', { class: 'picker-info' });
  const confirm = h('button', {
    class: ['btn', 'primary', 'wide-btn', opts.confirm.big && 'big-btn'],
    dataset: { testid: opts.confirm.testid ?? `${id}-confirm` },
  });
  const note = h('p', { class: 'note gold picker-note', dataset: { testid: `${id}-blocked` } });
  const el = h(
    'div',
    { class: 'picker', dataset: { testid: `${id}-picker` } },
    h('div', { class: 'picker-bar' }, search, sortBtn, filtersBtn, count),
    filters,
    h(
      'div',
      { class: 'split picker-split' },
      h('div', { class: 'grid-col' }, grid),
      h(
        'div',
        { class: 'panel detail picker-detail', dataset: { testid: `${id}-detail` } },
        info,
        h('div', { class: 'picker-foot' }, confirm, note),
      ),
    ),
  );

  // ---------------------------------------------------------------- the bar and the filters

  search.addEventListener('input', () => {
    filter.query = search.value;
    renderGrid();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown') return;
    const first = grid.querySelector<HTMLElement>('.cell');
    if (!first) return;
    e.preventDefault();
    first.focus();
  });
  sortBtn.addEventListener('click', () => {
    sort = POKEMON_SORTS[(POKEMON_SORTS.indexOf(sort) + 1) % POKEMON_SORTS.length] ?? 'dex';
    renderBar();
    renderGrid();
  });
  filtersBtn.addEventListener('click', () => {
    filtersOpen = !filtersOpen;
    renderBar();
  });

  const setFilter = (change: Partial<PokemonFilter>) => {
    Object.assign(filter, change);
    renderFilters();
    renderBar();
    renderGrid();
  };

  const renderBar = () => {
    sortBtn.textContent = t('picker.sort', { 0: t(SORT_LABEL[sort]) });
    const on = activeFilters(filter);
    filtersBtn.textContent = on ? t('picker.filtersOn', { 0: on }) : t('picker.filters');
    filtersBtn.setAttribute('aria-expanded', String(filtersOpen));
    filtersBtn.classList.toggle('on', on > 0);
    el.classList.toggle('filters-open', filtersOpen);
  };

  const renderFilters = () => {
    const mine = ownedMons();
    replace(
      regions,
      regionTabs(
        filter.gen,
        (gen) => setFilter({ gen }),
        (gen) => String(mine.filter((p) => p.gen === gen).length),
        { label: t('picker.all'), count: String(mine.length) },
      ),
    );
    replace(
      chips,
      activeFilters(filter)
        ? chip(
            t('picker.clear'),
            false,
            () => setFilter({ ...NO_FILTER, query: filter.query }),
            `${id}-clear`,
          )
        : null,
      chip(
        shinyChipLabel(),
        filter.shiny,
        () => setFilter({ shiny: !filter.shiny }),
        `${id}-shiny`,
      ),
      RARITIES.map((r) =>
        chip(
          rarityChipLabel(r),
          filter.rarity === r,
          () => setFilter({ rarity: filter.rarity === r ? 0 : r }),
          `${id}-rarity-${r}`,
        ),
      ),
    );
    replace(
      types,
      data.types.types.map((ty) =>
        chip(
          typeChip(ty.id),
          filter.type === ty.id,
          () => setFilter({ type: filter.type === ty.id ? '' : ty.id }),
          `${id}-type-${ty.id}`,
        ),
      ),
    );
  };

  // ---------------------------------------------------------------- the grid

  const select = (dex: number) => {
    if (dex === selected) return;
    const s = app.save;
    selected = dex;
    viewShiny = !!s && dex === s.partner.dex && s.partner.shiny && ownsShiny(dex);
    markCell(grid, dex);
    renderDetail();
  };

  // The selection follows the focus (the arrow keys, the gamepad, a tap).
  grid.addEventListener('focusin', (e) => {
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('.cell') : null;
    if (cell?.dataset.dex) select(Number(cell.dataset.dex));
  });

  const renderGrid = () => {
    const s = app.save;
    if (!s) return;
    const mine = ownedMons();
    const mons = sortPokemon(filterPokemon(mine, filter, s, pokemonName), sort, s, pokemonName);
    count.textContent = t('picker.count', { 0: mons.length, 1: mine.length });
    replace(
      grid,
      mons.length
        ? mons.map((p) => {
            const isPartner = p.dex === s.partner.dex;
            const levels = upgradeLevel(s, p.dex);
            return pokemonCell(p, {
              testid: `${id}-pick-${p.dex}`,
              own: true,
              selected: p.dex === selected,
              partner: isPartner,
              hasShiny: ownsShiny(p.dex),
              shiny: isPartner && s.partner.shiny && ownsShiny(p.dex),
              tag: levels ? t('picker.upgradeTag', { 0: levels }) : null,
              onClick: (e) => {
                select(p.dex);
                // A or Enter (not a pointer): on to the confirm button.
                if (e.detail === 0 && !confirm.disabled) confirm.focus();
              },
            });
          })
        : h(
            'p',
            { class: 'sub picker-empty', dataset: { testid: `${id}-none` } },
            t('picker.noMatch'),
          ),
    );
  };

  // ---------------------------------------------------------------- the details

  const renderDetail = () => {
    const s = app.save;
    const p = data.pokemonByDex.get(selected);
    if (!s || !p) return;
    const hasShiny = ownsShiny(p.dex);
    if (!hasShiny) viewShiny = false;
    const isPartner = p.dex === s.partner.dex && s.partner.shiny === viewShiny;
    const levels = upgradeLevel(s, p.dex);
    replace(
      info,
      pokemonDetail(p, {
        own: true,
        compact: true,
        hasShiny,
        viewShiny,
        onShiny: (shiny) => {
          viewShiny = shiny;
          renderDetail();
        },
        extra: levels
          ? h('div', { class: 'small gold' }, t('picker.upgradeLevels', { 0: levels }))
          : null,
      }),
    );
    renderConfirm(p, isPartner);
  };

  const renderConfirm = (p: Pokemon, isPartner: boolean) => {
    const blocked = opts.confirm.blocked?.(p, viewShiny, isPartner) ?? null;
    confirm.textContent = opts.confirm.label(p, viewShiny, isPartner);
    if (!confirm.classList.contains('loading')) confirm.disabled = blocked !== null;
    note.textContent = blocked ?? '';
    note.classList.toggle('hidden', !blocked);
  };

  confirm.addEventListener('click', () => {
    const p = data.pokemonByDex.get(selected);
    if (p && !confirm.disabled) opts.confirm.onConfirm(p, viewShiny, confirm);
  });

  const render = () => {
    const s = app.save;
    if (!s) return;
    // A Pokémon no longer owned (it can't be, but a stale save could say so) falls back.
    if (!owns(selected)) selected = s.partner.dex ?? ownedMons()[0]?.dex ?? 0;
    renderBar();
    renderFilters();
    renderGrid();
    renderDetail();
  };

  render();
  // Show the selected Pokémon once the picker is on screen (it may be far down the grid).
  requestAnimationFrame(() => {
    grid.querySelector<HTMLElement>('.cell.on')?.scrollIntoView?.({ block: 'nearest' });
  });
  const off = app.events.on('save', render);
  return {
    el,
    refresh: () => {
      const p = data.pokemonByDex.get(selected);
      const s = app.save;
      if (p && s) renderConfirm(p, p.dex === s.partner.dex && s.partner.shiny === viewShiny);
    },
    destroy: off,
  };
}
