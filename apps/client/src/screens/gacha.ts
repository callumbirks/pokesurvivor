// The gacha: a banner per generation, ×1 / ×10 pulls paid with tickets or a ×10 ticket, the
// pity counter, the rates, and the reveal. Every number comes from the server (`GET /api/gacha`
// and the pull's response): the client never rolls or computes a result.
import { t } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import type { GachaBanner, GachaInfo, PayWith, PullResponse, PullResult } from '../app/api.js';
import {
  CursorList,
  gameData,
  boxFor,
  h,
  icon,
  num,
  pokemonName,
  rarityBall,
  replace,
  sprite,
  tNodes,
} from '../app/dom.js';
import { SlotMachine } from '../app/slots.js';
import { backButton, loadInto } from './common.js';

let bannerId: string | null = null;

const pct = (x: number) => `${Number((x * 100).toFixed(2))}%`;

export function gachaScreen(app: App): Screen {
  const body = h('div', { class: 'gacha-body' });
  const el = h(
    'section',
    { class: 'scr scr-gacha', dataset: { testid: 'screen-gacha' } },
    h(
      'header',
      { class: 'scr-head' },
      h('h1', { class: 'field-title' }, t('gacha.gacha')),
      backButton(app),
    ),
    body,
  );
  const overlay = h('div', { class: 'pull-fx hidden', dataset: { testid: 'pull-fx' } });
  el.append(overlay);
  const regions = h('nav', {
    class: 'win regions',
    'aria-label': t('gacha.gacha'),
    dataset: { testid: 'banner-tabs' },
  });
  // The banner on show is the selected region: pointing at one, moving the focus onto it or
  // clicking it shows it.
  const list = new CursorList(regions, {
    navDefault: true,
    onSelect: (item) => {
      bannerId = item.dataset.banner ?? null;
      for (const b of regions.children) b.toggleAttribute('aria-current', b === item);
      render();
    },
  });
  /** The banner, the pulls and the odds (re-rendered without touching the regions' focus). */
  const main = h('div', { class: 'gacha-main' });
  let info: GachaInfo | null = null;
  let pulling = false;
  let machine: SlotMachine | null = null;

  const rarity = (r: number) => info?.rarities.find((x) => x.rarity === r);
  const color = (res: Pick<PullResult, 'rarity' | 'shiny'>) =>
    res.shiny ? '#9ae6ff' : (rarity(res.rarity)?.color ?? '#fff');

  const render = () => {
    const s = app.save;
    if (!info || !s) return;
    const banner = info.banners.find((b) => b.id === bannerId) ?? info.banners[0];
    if (!banner) return;
    bannerId = banner.id;
    const genMons = gameData().pokedex.filter((p) => p.gen === banner.gen);
    const poolTotal = Object.values(banner.poolSize).reduce((a, b) => a + b, 0);
    const owned = genMons.filter((p) => s.owned[String(p.dex)]).length;
    const shinies = genMons.filter((p) => s.shiny[String(p.dex)]).length;
    const pity = s.pity[banner.id] ?? banner.pity ?? 0;
    const [c1 = '#3a1d6e', c2 = '#1b2f78', c3 = '#0f4d6e'] = banner.colors;
    const { cost } = info;
    const pullButton = (
      count: number,
      payWith: PayWith,
      label: string,
      price: Node,
      affordable: boolean,
      primary: boolean,
      testid: string,
    ) => {
      const b = h(
        'button',
        {
          class: ['btn', 'pull-btn', primary && 'primary'],
          disabled: !affordable,
          // The pull plays its own sounds (original implementation and slots.js).
          dataset: { testid, sfx: 'none' },
        },
        label,
        h('span', { class: 'price' }, '· ', price),
      );
      b.addEventListener('click', () => void pull(banner, count, payWith, b));
      return b;
    };
    const ticket = (n: number, x10 = false) => [icon(x10 ? 'ticket10' : 'ticket', 18), ` ${n}`];

    // Roughly one multi per cell, with the soft-pity marker positioned by its exact threshold.
    const cellCount = Math.ceil(info.hardPity / cost.multiCount);
    const perCell = info.hardPity / cellCount;
    const filled = Math.max(0, Math.min(cellCount, Math.floor(pity / perCell)));
    const softCell = Math.floor((info.softPity.from - 1) / perCell);
    const cells = h(
      'div',
      {
        class: 'pity-cells',
        style: { '--pity-cell-count': String(cellCount) },
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(info.hardPity),
        'aria-valuenow': String(Math.min(info.hardPity, Math.max(0, pity))),
        'aria-label': t('gacha.pullsWithoutALegendaryIn', {
          0: banner.name,
          1: pity,
          2: info.hardPity,
        }),
        title: t('app.softPityFrom', { 0: info.softPity.from }),
      },
      Array.from({ length: cellCount }, (_, i) =>
        h('i', { class: [i < filled && 'f', i >= softCell && 'soft'] }),
      ),
      h(
        'small',
        { style: { left: `${(info.softPity.from / info.hardPity) * 100}%` } },
        String(info.softPity.from),
      ),
    );

    replace(
      main,
      h(
        'div',
        { class: 'win banner-win' },
        h(
          'div',
          {
            class: 'banner-art',
            // Flat bands of the region's colours for a sky, over the dungeon floor.
            style: {
              '--sky1': c1,
              '--sky2': c2,
              '--sky3': c3,
            },
          },
          h(
            'div',
            { class: 'banner-txt' },
            h('h2', null, `${banner.name} ${t('gacha.mystery')}`),
            h('p', null, t('gacha.thePokemonOfGenerationThe', { 0: poolTotal, 1: banner.gen })),
            h(
              'p',
              null,
              t('gacha.youHaveOf', { 0: owned, 1: genMons.length }),
              shinies ? [' · ', icon('shiny', 12), ` ${shinies}`] : null,
            ),
          ),
          h(
            'div',
            { class: 'feat' },
            banner.featured.map((dex) =>
              sprite(dex, {
                scale: 2,
                lively: true,
                // Big legendaries (Eternatus, Rayquaza…) scale down to stay under the text.
                fit: boxFor({ width: 190, height: 160 }, { width: 104, height: 86 }),
                feet: true,
              }),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'win pulls-win' },
        h(
          'div',
          { class: 'pull-btns' },
          pullButton(
            1,
            'tickets',
            t('gacha.pullOne'),
            h('span', null, ticket(cost.single)),
            s.tickets.x1 >= cost.single,
            true,
            'pull-1',
          ),
          pullButton(
            cost.multiCount,
            'tickets',
            t('gacha.pullTen'),
            h('span', null, ticket(cost.multi)),
            s.tickets.x1 >= cost.multi,
            false,
            'pull-10',
          ),
          pullButton(
            cost.multiCount,
            'tickets10',
            t('gacha.pullTen'),
            h('span', null, ticket(cost.multiTickets10, true)),
            s.tickets.x10 >= cost.multiTickets10,
            false,
            'pull-10b',
          ),
        ),
        h(
          'p',
          { class: 'tickets-line' },
          tNodes('app.youHaveTickets', {
            ticket: icon('ticket', 18),
            ticket10: icon('ticket10', 18),
            0: num(s.tickets.x1),
            1: num(s.tickets.x10),
          }),
        ),
        h(
          'p',
          { class: 'pity', dataset: { testid: 'pity' } },
          tNodes('gacha.pullsWithoutALegendaryIn', {
            0: banner.name,
            1: h('b', null, String(pity)),
            2: String(info.hardPity),
          }),
        ),
        cells,
      ),
      rates(info, banner),
    );
  };

  const rates = (g: GachaInfo, banner: GachaBanner) => {
    const total = g.rates.reduce((a, r) => a + r.weight, 0);
    const minRarity = rarity(g.multiGuaranteeMinRarity)?.name ?? String(g.multiGuaranteeMinRarity);
    return h(
      'div',
      { class: 'win odds-win', dataset: { testid: 'rates' } },
      h('h3', null, t('gacha.odds')),
      [...g.rates]
        .reverse()
        .map((r) =>
          h(
            'div',
            { class: 'odds-row', style: { color: rarity(r.rarity)?.color ?? 'inherit' } },
            rarityBall(r.rarity, 12),
            h('span', null, rarity(r.rarity)?.name ?? ''),
            h('span', null, pct(r.weight / total)),
            h('span', { class: 'c' }, String(banner.poolSize[String(r.rarity)] ?? 0)),
          ),
        ),
      h(
        'div',
        { class: 'odds-row shiny' },
        icon('shiny', 12),
        h('span', null, t('app.shiny')),
        h('span', null, pct(g.shinyRate)),
        h('span', { class: 'c' }),
      ),
      h(
        'ul',
        { class: 'rules' },
        h('li', null, t('app.ruleMulti', { 0: g.cost.multiCount, 1: minRarity })),
        h(
          'li',
          null,
          t('app.ruleSoftPity', {
            0: g.softPity.from,
            1: Number((g.softPity.stepPerPull * 100).toFixed(2)),
          }),
        ),
        h('li', null, t('app.ruleHardPity', { 0: g.hardPity })),
        h(
          'li',
          null,
          t('app.ruleRefund'),
          ' ',
          g.duplicateRefund.map((d, i) => [
            i ? ' · ' : '',
            rarityBall(d.rarity, 12),
            ` ${d.coins}`,
          ]),
        ),
        h('li', null, t('app.ruleShiny')),
        h('li', null, t('app.ruleTickets')),
      ),
    );
  };

  const pull = async (
    banner: GachaBanner,
    count: number,
    payWith: PayWith,
    button: HTMLButtonElement,
  ) => {
    if (pulling) return;
    pulling = true;
    const res = await app.act(button, () => app.api.pull(banner.id, count, payWith));
    if (!res) {
      pulling = false;
      return;
    }
    await reveal(res);
    pulling = false;
  };

  /** Pokéball drop and shake (longer for epic, legendary or shiny), then the cards one by one. */
  const reveal = async (res: PullResponse) => {
    let fast = false;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, fast ? ms / 5 : ms));
    const best = res.results.reduce(
      (a, r) => (r.rarity > a.rarity || (r.shiny && !a.shiny) ? r : a),
      res.results[0] ?? { rarity: 1, shiny: false },
    );
    const slot = h('canvas', {
      class: 'slot',
      title: t('gacha.clickToSpeedUp'),
      dataset: { testid: 'slot-machine' },
    });
    machine?.stop();
    machine = new SlotMachine(slot, {
      color: (r) => rarity(r)?.color ?? '#fff',
      name: (r) => rarity(r)?.name ?? String(r),
    });
    const cards = h('div', { class: 'pull-results', dataset: { testid: 'pull-results' } });
    const close = h(
      'button',
      { class: 'btn gold hidden', dataset: { testid: 'pull-close' } },
      t('pause.continue'),
    );
    const done = new Promise<void>((resolve) => close.addEventListener('click', () => resolve()));
    replace(overlay, slot, cards, close);
    overlay.classList.remove('hidden');
    overlay.onclick = () => {
      fast = true;
      machine?.hurry();
    };

    // The slot machine (lever, reels, prize sounds), then the burst and the cards one by one.
    await machine.play(res.results);
    machine = null;
    audio.sfx('burst', { rarity: best.rarity });
    slot.remove();
    for (const r of res.results) {
      cards.append(card(r));
      audio.sfx('reveal', { rarity: r.rarity });
      await wait(res.results.length > 1 ? 150 : 0);
    }
    close.classList.remove('hidden');
    close.focus();
    // The save (tickets, collection, pity, refunds) and achievements came with the response.
    app.setSave(res.save);
    app.achievements(res.achievements);
    await done;
    overlay.classList.add('hidden');
    overlay.replaceChildren();
    render();
  };

  const card = (r: PullResult) => {
    const rc = color(r);
    return h(
      'div',
      {
        class: ['pcard', `r${r.rarity}`, r.shiny && 'shiny'],
        style: { '--rc': rc },
        dataset: { testid: 'pull-card' },
      },
      h('div', { class: 'stars' }, rarityBall(r.rarity, 24)),
      // A fixed stage, as legacy's 132×120 canvas: every card is the same size.
      h(
        'div',
        { class: 'pstage' },
        sprite(r.dex, {
          scale: 2,
          shiny: r.shiny,
          lively: r.rarity >= 4 || r.shiny,
          fit: boxFor({ width: 128, height: 96 }, { width: 84, height: 60 }),
          feet: true,
        }),
      ),
      h('b', null, r.shiny ? [icon('shiny', 12), ' '] : null, pokemonName(r.dex)),
      h(
        'div',
        { class: 'tag' },
        r.isNew
          ? h('span', { class: 'new' }, r.shiny ? t('gacha.newShiny') : t('gacha.new'))
          : [t('app.duplicate'), ' · ', icon('coin', 12), ` +${num(r.refund)}`],
      ),
    );
  };

  /** The regions, once: the selection then shows its banner. */
  const showRegions = (g: GachaInfo) => {
    replace(
      regions,
      g.banners.map((b) =>
        h(
          'button',
          {
            class: 'cursor-item region',
            dataset: { testid: `banner-${b.id}`, banner: b.id },
            on: { click: (e) => list.select(e.currentTarget as HTMLElement) },
          },
          h('span', null, b.name),
          h('small', null, t('gacha.gen', { 0: b.gen })),
        ),
      ),
    );
    replace(body, regions, main);
    const current = g.banners.find((b) => b.id === bannerId) ?? g.banners[0];
    list.select(regions.querySelector<HTMLElement>(`[data-banner="${current?.id}"]`));
  };

  loadInto(
    body,
    () => app.gacha(),
    (g) => {
      info = g;
      showRegions(g);
    },
  );
  const off = app.events.on('save', () => {
    if (!pulling) render();
  });
  return {
    el,
    destroy() {
      off();
      machine?.stop();
    },
  };
}
