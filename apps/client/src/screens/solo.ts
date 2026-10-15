// Solo: pick the Pokémon (the shared picker, on the partner), then start a run in the browser.
// Play makes the pick the partner first. The solo connection records the run's start on the
// server, checkpoints it and reports its results when the sim ends (see SoloApi).
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { pokemonPicker } from '../app/pokemon-picker.js';
import { playSolo } from '../app/solo-runs.js';
import { prestigeOf } from '../app/prestige.js';
import { gameData } from '../app/dom.js';
import { screenBox } from './common.js';

export function soloScreen(app: App): Screen {
  const box = screenBox(app, { id: 'solo', title: t('app.solo') });
  const data = gameData();

  const picker = pokemonPicker(app, {
    id: 'solo',
    confirm: {
      big: true,
      testid: 'solo-start',
      label: () => t('menu.play'),
      // A player in a party can't start a solo run (the server refuses too: 409 in_room).
      blocked: () => (app.net?.roomView ? t('app.leaveRoomForSolo') : null),
      onConfirm: (p, shiny, button) => {
        void app.act(button, async () => {
          let s = app.save;
          if (!s || app.net?.roomView) return;
          if (s.partner.dex !== p.dex || s.partner.shiny !== shiny) {
            s = await app.api.setPartner(p.dex, shiny);
            app.setSave(s);
          }
          const key = String(p.dex);
          // The connection starts the run on the server, checkpoints it and reports it when the
          // sim ends; the shell binds the calls to this player and keeps the save and toasts up
          // to date.
          playSolo(
            app,
            {
              id: app.user?.id ?? 'solo',
              dex: p.dex,
              shiny,
              upgrades: s.upgrades[key] ?? {},
              prestige: prestigeOf(s, p.dex),
              bannedMoves: s.moveBans[key] ?? [],
              moveBindings: s.moveBindings[key] ?? [],
              legendsBeaten: Object.keys(s.legendsBeaten).map(Number),
            },
            Object.keys(s.owned)
              .map(Number)
              .filter((d) => data.pokemonByDex.has(d))
              .sort((a, b) => a - b),
          );
        });
      },
    },
  });
  box.body.append(picker.el);

  const offs = [app.net?.on('room', () => picker.refresh())];
  return {
    el: box.el,
    destroy: () => {
      picker.destroy();
      offs.forEach((off) => off?.());
    },
  };
}
