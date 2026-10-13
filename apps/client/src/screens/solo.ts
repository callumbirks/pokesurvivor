// Solo: pick the partner, then start a run in the browser. The solo connection records the run's
// start on the server, checkpoints it and reports its results when the sim ends (see SoloApi).
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { playSolo } from '../app/solo-runs.js';
import {
  gameData,
  h,
  pokemonName,
  replace,
  sprite,
  rarityBall,
  typeChip,
  typeColor,
} from '../app/dom.js';
import { screenBox } from './common.js';

export function soloScreen(app: App): Screen {
  const box = screenBox(app, { id: 'solo', title: t('app.solo') });
  const data = gameData();

  const render = () => {
    const s = app.save;
    if (!s) return;
    const dex = s.partner.dex ?? 0;
    const shiny = s.partner.shiny && !!s.shiny[String(dex)];
    const mon = data.pokemonByDex.get(dex);
    const owned = Object.keys(s.owned)
      .map(Number)
      .filter((d) => data.pokemonByDex.has(d))
      .sort((a, b) => a - b);
    const start = h(
      'button',
      { class: 'btn gold big-btn', dataset: { testid: 'solo-start' } },
      t('menu.play'),
    );
    start.addEventListener('click', () => {
      // The connection starts the run on the server, checkpoints it and reports it when the sim
      // ends; the shell binds the calls to this player and keeps the save and toasts up to date.
      const key = String(dex);
      playSolo(
        app,
        {
          id: app.user?.id ?? 'solo',
          dex,
          shiny,
          upgrades: s.upgrades[key] ?? {},
          bannedMoves: s.moveBans[key] ?? [],
          moveBindings: s.moveBindings[key] ?? [],
          legendsBeaten: Object.keys(s.legendsBeaten).map(Number),
        },
        owned,
      );
    });
    replace(
      box.body,
      h(
        'div',
        { class: 'split solo' },
        h(
          'div',
          { class: 'center' },
          h(
            'div',
            {
              class: ['stage', shiny && 'shiny'],
              style: { '--stage-c': shiny ? '#9ae6ff' : typeColor(mon?.types[0] ?? 'normal') },
            },
            sprite(dex, { scale: 4, lively: true, shiny }),
          ),
          h('h3', { dataset: { testid: 'solo-partner' } }, pokemonName(dex), shiny ? ' ✦' : ''),
          h(
            'div',
            null,
            ...(mon?.types.map(typeChip) ?? []),
            ' ',
            mon ? rarityBall(mon.rarity, 12) : null,
          ),
          h('p', { class: 'sub' }, t('hud.surviveTheHordesWithYour')),
          start,
        ),
        h(
          'div',
          null,
          h('h4', null, t('login.chooseYourPartner')),
          h(
            'div',
            { class: 'grid small-grid' },
            owned.map((d) => {
              const cell = h(
                'button',
                { class: ['cell', d === dex && 'on'], dataset: { testid: `solo-pick-${d}` } },
                sprite(d, { scale: 1.5 }),
                h('b', null, pokemonName(d)),
              );
              cell.addEventListener('click', () => {
                if (d === dex) return;
                void app.act(null, async () => app.setSave(await app.api.setPartner(d, false)));
              });
              return cell;
            }),
          ),
        ),
      ),
    );
  };

  render();
  const off = app.events.on('save', render);
  return { el: box.el, destroy: off };
}
