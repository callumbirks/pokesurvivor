// Leaderboards: solo or group, daily / weekly / all-time, optionally friends only or one Pokémon.
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import type {
  Leaderboard,
  LeaderboardEntry,
  LeaderboardMode,
  LeaderboardPeriod,
} from '../app/api.js';
import { gameData, h, icon, mmss, replace, sprite } from '../app/dom.js';
import { loadInto, screenBox, tabs } from './common.js';

const query: {
  mode: LeaderboardMode;
  period: LeaderboardPeriod;
  friends: boolean;
  pokemon: number | null;
} = {
  mode: 'solo',
  period: 'weekly',
  friends: false,
  pokemon: null,
};

export function rankingScreen(app: App): Screen {
  const box = screenBox(app, { id: 'ranking', title: t('menu.leaderboard') });
  const controls = h('div', { class: 'rk-controls' });
  const list = h('div', { class: 'rk-list', dataset: { testid: 'leaderboard' } });
  const me = h('div', { class: 'rk-me' });
  box.body.append(controls, list, me);
  const data = gameData();

  const row = (e: LeaderboardEntry, mine: boolean) =>
    h(
      'div',
      { class: ['rk-row', e.rank <= 3 && `top${e.rank}`, mine && 'mine'] },
      h('span', { class: 'pos' }, e.rank <= 3 ? icon('trophy', 20) : null, String(e.rank)),
      h(
        'span',
        { class: 'mons' },
        e.players.map((p) => sprite(p.pokemon.dex, { scale: 1, shiny: p.pokemon.shiny })),
      ),
      h(
        'span',
        { class: 'who' },
        h('b', null, e.players.map((p) => p.username).join(' · ')),
        h(
          'small',
          null,
          e.players.map((p) => t('leaderboard.lvDefeated', { 0: p.level, 1: p.kills })).join(' · '),
        ),
      ),
      h('span', { class: 'time' }, mmss(e.durationS)),
    );

  const show = (board: Leaderboard) => {
    const name = app.user?.username;
    replace(
      list,
      board.entries.length
        ? board.entries.map((e) =>
            row(
              e,
              e.players.some((p) => p.username === name),
            ),
          )
        : h('p', { class: 'sub' }, t('leaderboard.noRecordsHereYetBe')),
    );
    replace(me, board.me ? row(board.me, true) : t('app.noRecordYet'));
  };

  const load = () =>
    loadInto(
      list,
      () => app.api.leaderboard({ ...query, pokemon: query.pokemon ?? undefined }),
      show,
    );

  const render = () => {
    const pokemon = h('input', {
      class: 'field',
      list: 'rk-pokemon',
      placeholder: t('leaderboard.filterByPokemonAllTime'),
      value: query.pokemon ? (data.pokemonByDex.get(query.pokemon)?.name ?? '') : '',
      spellcheck: 'false',
    });
    pokemon.addEventListener('change', () => {
      const v = pokemon.value.trim().toLowerCase();
      const found = v ? data.pokedex.find((p) => p.name.toLowerCase() === v) : undefined;
      if (v && !found) {
        pokemon.setCustomValidity(t('leaderboard.thereSNoPokemonWith'));
        pokemon.reportValidity();
        return;
      }
      pokemon.setCustomValidity('');
      query.pokemon = found?.dex ?? null;
      render();
    });
    replace(
      controls,
      tabs<LeaderboardMode>(
        [
          { id: 'solo', label: h('b', null, icon('user', 16), ' ', t('app.soloBoard')) },
          { id: 'group', label: h('b', null, icon('friends', 16), ' ', t('leaderboard.group2')) },
        ],
        query.mode,
        (m) => ((query.mode = m), render()),
        'gen-tabs',
      ),
      h(
        'div',
        { class: 'row rk-tools' },
        tabs<LeaderboardPeriod>(
          [
            { id: 'daily', label: t('leaderboard.daily') },
            { id: 'weekly', label: t('leaderboard.weekly') },
            { id: 'all', label: t('leaderboard.allTime') },
          ],
          query.period,
          (p) => ((query.period = p), render()),
          'filters',
        ),
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: query.friends,
            on: {
              change: (e) => {
                query.friends = (e.target as HTMLInputElement).checked;
                render();
              },
            },
          }),
          ' ',
          t('leaderboard.friendsOnly'),
        ),
        pokemon,
        h(
          'datalist',
          { id: 'rk-pokemon' },
          data.pokedex.map((p) => h('option', { value: p.name })),
        ),
        query.pokemon
          ? h(
              'button',
              { class: 'btn small ghost', on: { click: () => ((query.pokemon = null), render()) } },
              t('leaderboard.clearFilter'),
            )
          : null,
      ),
    );
    load();
  };

  render();
  return { el: box.el };
}
