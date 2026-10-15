// Pokémon widgets shared by the collection and the Pokémon picker: the region tabs, the
// shiny / rarity chips, a grid cell, and the detail panel (stage, types, stats, starting move).
import { prestigeBonus, t, type Pokemon } from '@pokesurvivor/data';
import { boxFor, gameData, h, icon, rarityBall, rarityInfo, sprite, typeChip } from './dom.js';
import { movePoolOf, startingMoveOf } from './moves.js';
import { prestigeBox, stars } from './prestige.js';

/**
 * The region (generation) tabs: one per gacha banner, each with `count(gen)` under its name,
 * and an "All" tab first with `all`.
 */
export function regionTabs(
  current: number,
  onPick: (gen: number) => void,
  count: (gen: number) => string,
  all?: { label: string; count: string },
): HTMLElement[] {
  const tab = (gen: number, label: string, small: string) =>
    h(
      'button',
      {
        class: ['gen-tab', gen === current && 'on'],
        'aria-pressed': gen === current ? 'true' : 'false',
        dataset: { testid: `region-${gen}` },
        on: { click: () => onPick(gen) },
      },
      h('b', null, label),
      h('small', null, small),
    );
  return [
    ...(all ? [tab(0, all.label, all.count)] : []),
    ...gameData().gacha.banners.map((b) => tab(b.gen, b.name, count(b.gen))),
  ];
}

/** A filter chip; `on` is inverse video. */
export function chip(
  label: string | Node,
  on: boolean,
  onClick: () => void,
  testid?: string,
): HTMLElement {
  return h(
    'button',
    {
      class: ['chip', on && 'on'],
      'aria-pressed': on ? 'true' : 'false',
      dataset: testid ? { testid } : {},
      on: { click: onClick },
    },
    label,
  );
}

/** As legacy: the shiny chip's label, the shiny icon. */
export const shinyChipLabel = (): Node => h('span', null, icon('shiny', 12), ' ', t('app.shiny'));

/** A rarity chip's label: its Poké Ball and name. */
export const rarityChipLabel = (r: number): Node =>
  h('span', null, rarityBall(r, 12), ' ', rarityInfo(r).name);

/** Rarities, rarest first, as the chips list them. */
export const RARITIES = [5, 4, 3, 2, 1] as const;

export interface CellOptions {
  testid: string;
  own: boolean;
  selected: boolean;
  /** The player's partner: the crown. */
  partner: boolean;
  /** Its shiny is owned: the shiny mark (when not the partner). */
  hasShiny: boolean;
  /** Draw the shiny. */
  shiny: boolean;
  /** A tag in the bottom corner (upgrade levels). */
  tag?: string | null;
  /** Prestige stars, by the name. */
  prestige?: number;
  /** `e.detail` is 0 for A or Enter, as for any click without a pointer. */
  onClick: (e: MouseEvent) => void;
}

/** A grid cell: dex number, crown or shiny mark, the sprite, the name and the rarity's ball. */
export function pokemonCell(p: Pokemon, o: CellOptions): HTMLElement {
  return h(
    'button',
    {
      class: ['cell', !o.own && 'locked', o.selected && 'on'],
      // The selected Pokémon is where the gamepad's first press starts.
      dataset: { testid: o.testid, dex: String(p.dex), ...(o.selected ? { navDefault: '' } : {}) },
      on: { click: o.onClick },
    },
    h('span', { class: 'no' }, String(p.dex).padStart(3, '0')),
    o.partner
      ? h('span', { class: 'badge-r', title: t('collection.itSYourPartner') }, icon('crown', 14))
      : o.hasShiny
        ? h('span', { class: 'badge-r' }, icon('shiny', 12))
        : null,
    h(
      'span',
      { class: 'cell-stage' },
      sprite(p.dex, {
        scale: 1.5,
        silhouette: !o.own,
        shiny: o.shiny,
        fit: { width: 80, height: 58 },
        feet: true,
      }),
    ),
    h('b', null, o.own ? p.name : '???'),
    o.own ? stars(o.prestige, 'cell-stars') : null,
    h(
      'span',
      { class: 'cell-foot' },
      rarityBall(p.rarity, 12),
      o.tag ? h('span', { class: 'badge dim cell-tag' }, o.tag) : null,
    ),
  );
}

/** Moves `.on` and the gamepad's start to the cell of `dex` in `grid`. */
export function markCell(grid: HTMLElement, dex: number): void {
  for (const c of grid.querySelectorAll<HTMLElement>('.cell')) {
    const on = c.dataset.dex === String(dex);
    c.classList.toggle('on', on);
    c.toggleAttribute('data-nav-default', on);
  }
}

export interface DetailOptions {
  own: boolean;
  hasShiny: boolean;
  viewShiny: boolean;
  /** The Normal / Shiny switch (shown when the shiny is owned). */
  onShiny: (shiny: boolean) => void;
  /** Under the name: e.g. the upgrade levels. */
  extra?: Node | null;
  /** A shorter stage (the picker, which also shows the filters). */
  compact?: boolean;
  /** Prestige stars: by the name, as gold tips on the stat bars, and the "Prestige" box. */
  prestige?: number;
}

/** Bar lengths: the largest base stats in the Pokédex (HP, attack, speed). */
const BAR_MAX = { hp: 183, attack: 1.55, speed: 137 };

/**
 * HP, attack and speed bars of a Pokémon's base stats; with prestige stars, each bar gets a gold
 * tip for the prestige share and its value includes it, then the "Prestige" box of % chips.
 */
export function statBars(p: Pokemon, prestige = 0): Node[] {
  const b = prestigeBonus(gameData().tuning.prestige, prestige);
  const pct = (mul: number) => Math.round((mul - 1) * 100);
  const bar = (label: string, v: number, mul: number, max: number, text: string) => {
    const base = Math.min(100, (v / max) * 100);
    const tip = Math.min(100 - base, base * (mul - 1));
    return h(
      'div',
      { class: 'stat' },
      h('span', null, label),
      h(
        'div',
        { class: 'bar' },
        h('i', { style: { width: `${base}%` } }),
        tip > 0 ? h('b', { style: { left: `${base}%`, width: `${tip}%` } }) : null,
      ),
      h('span', null, text, mul > 1 ? [' ', h('em', { class: 'gold' }, `+${pct(mul)}%`)] : null),
    );
  };
  return [
    bar(t('collection.hp'), p.hp, b.hpMul, BAR_MAX.hp, String(Math.round(p.hp * b.hpMul))),
    bar(
      t('collection.attack'),
      p.attack,
      b.damageMul,
      BAR_MAX.attack,
      `×${(p.attack * b.damageMul).toFixed(2)}`,
    ),
    bar(
      t('collection.speed'),
      p.speed,
      b.speedMul,
      BAR_MAX.speed,
      String(Math.round(p.speed * b.speedMul)),
    ),
    prestigeBox(prestige),
  ].filter((n): n is HTMLElement => n !== null);
}

/**
 * The detail panel's content: the stage, the Normal / Shiny switch, dex number, region, name,
 * rarity and types, then (when owned) the stats, the starting move and the learnable moves.
 */
export function pokemonDetail(p: Pokemon, o: DetailOptions): Node[] {
  const data = gameData();
  const banner = data.gacha.banners.find((b) => b.gen === p.gen);
  const shown = o.own && o.viewShiny;
  const nodes: (Node | null)[] = [
    h(
      'div',
      { class: ['stage', shown && 'shiny', o.compact && 'compact'] },
      sprite(p.dex, {
        scale: 3,
        lively: o.own,
        silhouette: !o.own,
        shiny: shown,
        fit: o.compact
          ? boxFor({ width: 216, height: 104 }, { width: 130, height: 80 })
          : boxFor({ width: 216, height: 150 }, { width: 130, height: 96 }),
        feet: true,
      }),
    ),
    o.hasShiny
      ? h(
          'div',
          { class: 'seg' },
          h(
            'button',
            {
              class: !o.viewShiny ? 'on' : undefined,
              dataset: { testid: 'view-normal' },
              on: { click: () => o.onShiny(false) },
            },
            t('app.normal'),
          ),
          h(
            'button',
            {
              class: o.viewShiny ? 'on' : undefined,
              dataset: { testid: 'view-shiny' },
              on: { click: () => o.onShiny(true) },
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
      h(
        'h3',
        { dataset: { testid: 'detail-name' } },
        o.own ? p.name : '???',
        o.own && o.prestige ? [' ', stars(o.prestige)] : null,
      ),
      h(
        'div',
        { style: { color: rarityInfo(p.rarity).color } },
        rarityBall(p.rarity, 24),
        ' ',
        rarityInfo(p.rarity).name,
      ),
      o.own ? h('div', { style: 'margin:6px 0' }, p.types.map(typeChip)) : null,
      o.extra ?? null,
    ),
  ];
  if (o.own)
    nodes.push(
      ...statBars(p, o.prestige),
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
    );
  return nodes.filter((n): n is Node => n !== null);
}
