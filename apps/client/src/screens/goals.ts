// Goals: daily and weekly missions (claimed by hand), achievements, and the public profile
// (favourite Pokémon and title). Progress and rewards are the server's; the achievement bars
// are only a display of the save's counters.
import { formatText, t, type Achievement, type Reward } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import type { MissionState, Missions, Save } from '../app/api.js';
import { gameData, h, mmss, num, pokemonName, replace, sprite } from '../app/dom.js';
import { toast } from '../app/toast.js';
import { loadInto, screenBox, tabs } from './common.js';

type Tab = 'missions' | 'achievements' | 'profile';
let tab: Tab = 'missions';

export function rewardView(r: Reward): HTMLElement {
  return h(
    'span',
    { class: 'reward' },
    r.coins ? [h('span', { class: 'coin' }), ` ${num(r.coins)} `] : null,
    r.tickets ? [h('span', { class: 'ticket' }), ` ${r.tickets} `] : null,
    r.tickets10 ? [h('span', { class: 'ticket x10' }), ` ${r.tickets10}`] : null,
  );
}

export function missionText(m: MissionState): string {
  const tpl = gameData().missionById.get(m.id);
  if (!tpl) return m.id;
  const type = m.param
    ? (gameData().types.types.find((x) => x.id === m.param)?.name ?? m.param)
    : '';
  const text = m.goal === 1 && tpl.textSingular ? tpl.textSingular : tpl.text;
  return formatText(text, { count: m.goal, type });
}

/** An achievement's progress in a save, for its bar (the server decides unlocks). */
export function achievementValue(save: Save, a: Achievement): number {
  const s = save.stats;
  const count = (r: object) => Object.keys(r).length;
  switch (a.metric) {
    case 'pokemon-owned':
      return Object.keys(save.owned).filter((d) => gameData().pokemonByDex.has(Number(d))).length;
    case 'shinies-owned':
      return count(save.shiny);
    case 'gacha-pulls':
      return s.pulls;
    case 'best-time-minutes':
      return Math.floor(s.bestTimeS / 60);
    case 'best-level':
      return s.bestLevel;
    case 'runs':
      return s.runs;
    case 'total-defeated':
      return s.totalKills;
    case 'bosses-defeated':
      return s.bossesTotal;
    case 'move-evolutions':
      return s.evolutions;
    case 'distinct-moves-evolved':
      return count(save.movesEvolved);
    case 'distinct-items-found':
      return count(save.itemsFound);
    case 'rift-wins':
      return s.riftWins;
    case 'arenas-won':
      return count(save.arenasWon);
    case 'legendaries-defeated':
      return count(save.legendsBeaten);
    case 'legendary-defeated':
      return a.dex !== undefined && save.legendsBeaten[String(a.dex)] ? 1 : 0;
    case 'missions-done':
      return s.missionsDone;
    case 'group-runs':
      return s.groupRuns;
  }
}

const bar = (v: number, goal: number) =>
  h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, (v / goal) * 100)}%` } }));

export function goalsScreen(app: App): Screen {
  const box = screenBox(app, { id: 'goals', title: t('menu.missions') });
  const tabRow = h('div');
  const body = h('div', { class: 'goals-body' });
  box.body.append(tabRow, body);

  const show = () => {
    replace(
      tabRow,
      tabs<Tab>(
        [
          { id: 'missions', label: t('menu.missions'), testid: 'tab-missions' },
          { id: 'achievements', label: t('profile.achievements'), testid: 'tab-achievements' },
          { id: 'profile', label: t('profile.profile'), testid: 'tab-profile' },
        ],
        tab,
        (next) => {
          tab = next;
          show();
        },
      ),
    );
    if (tab === 'missions') loadInto(body, () => app.api.missions(), renderMissions);
    else if (tab === 'achievements') renderAchievements();
    else renderProfile();
  };

  const renderMissions = (missions: Missions) => {
    const section = (kind: 'daily' | 'weekly') => {
      const set = missions[kind];
      return [
        h(
          'div',
          { class: 'goals-h' },
          h('h3', null, t(kind === 'daily' ? 'profile.daily' : 'profile.weekly')),
        ),
        set.missions.map((m, index) => {
          const tpl = gameData().missionById.get(m.id);
          const done = m.progress >= m.goal;
          const claim = h(
            'button',
            {
              class: ['btn', 'small', done && !m.claimed && 'gold'],
              disabled: !done || m.claimed,
              dataset: { testid: `claim-${kind}-${index}` },
            },
            m.claimed ? t('profile.claimed') : done ? t('profile.claim') : t('profile.inProgress'),
          );
          claim.addEventListener('click', () => {
            void app.act(claim, async () => {
              const res = await app.api.claimMission(kind, index);
              app.setSave(res.save);
              app.achievements(res.achievements);
              toast(t('profile.rewardClaimed'), 'good');
              renderMissions(res.missions);
            });
          });
          const swap =
            kind === 'daily' && !m.claimed && !set.rerolled
              ? h(
                  'button',
                  {
                    class: 'btn small ghost',
                    title: t('profile.swapThisMissionForAnother'),
                    dataset: { testid: `reroll-${index}` },
                  },
                  t('profile.swap'),
                )
              : null;
          swap?.addEventListener('click', () => {
            void app.act(swap, async () => renderMissions(await app.api.rerollMission(index)));
          });
          return h(
            'div',
            {
              class: ['mission', done && !m.claimed && 'ready', m.claimed && 'claimed'],
              dataset: { testid: 'mission' },
            },
            h(
              'div',
              null,
              h('b', null, missionText(m)),
              bar(m.progress, m.goal),
              h('small', null, `${num(Math.floor(m.progress))} / ${num(m.goal)}`),
            ),
            tpl ? rewardView(tpl.reward) : null,
            h('div', { class: 'row' }, swap, claim),
          );
        }),
      ];
    };
    replace(body, section('daily'), section('weekly'));
  };

  const renderAchievements = () => {
    const s = app.save;
    if (!s) return;
    const { achievements } = gameData();
    const unlocked = achievements.achievements.filter((a) => s.achievements[a.id]);
    const titles = unlocked.filter((a) => a.title).length;
    replace(
      body,
      h(
        'p',
        { class: 'sub' },
        t('profile.ofAchievementsTitles', {
          0: unlocked.length,
          1: achievements.achievements.length,
          2: titles,
        }),
      ),
      achievements.categories.map((c) => {
        const list = achievements.achievements.filter((a) => a.category === c.id);
        if (c.id === 'legendaries') {
          const each = list.filter((a) => a.metric === 'legendary-defeated');
          const rest = list.filter((a) => a.metric !== 'legendary-defeated');
          return [
            h('h3', { class: 'goals-h' }, c.name),
            h(
              'div',
              { class: 'ach-grid' },
              rest.map((a) => achievement(s, a)),
            ),
            h(
              'p',
              { class: 'sub' },
              t('profile.legendariesDefeated', {
                0: each.filter((a) => s.achievements[a.id]).length,
                1: each.length,
              }),
            ),
            h(
              'div',
              { class: 'leg-grid' },
              each.map((a) =>
                h(
                  'div',
                  { class: ['leg-cell', !!s.achievements[a.id] && 'ok'], title: a.description },
                  a.dex ? sprite(a.dex, { scale: 1, silhouette: !s.achievements[a.id] }) : null,
                  h('small', null, a.dex ? pokemonName(a.dex) : a.name),
                ),
              ),
            ),
          ];
        }
        return [
          h('h3', { class: 'goals-h' }, c.name),
          h(
            'div',
            { class: 'ach-grid' },
            list.map((a) => achievement(s, a)),
          ),
        ];
      }),
    );
  };

  const achievement = (s: Save, a: Achievement) => {
    const ok = !!s.achievements[a.id];
    const v = Math.min(achievementValue(s, a), a.goal);
    return h(
      'div',
      { class: ['ach', ok && 'ok'] },
      h('span', { class: 'medal' }, ok ? '🏅' : '○'),
      h(
        'div',
        { class: 'a-txt' },
        h('b', null, a.name),
        h('small', null, a.description),
        ok
          ? h(
              'small',
              { class: 'gold' },
              t('profile.unlocked'),
              a.title ? ` · ${t('profile.title2', { 0: a.title })}` : '',
            )
          : [bar(v, a.goal), h('small', null, `${num(v)} / ${num(a.goal)}`)],
      ),
      rewardView(a.reward),
    );
  };

  const renderProfile = () => {
    const s = app.save;
    if (!s) return;
    const { achievements } = gameData();
    const titled = achievements.achievements.filter((a) => a.title && s.achievements[a.id]);
    const owned = Object.keys(s.owned)
      .map(Number)
      .sort((a, b) => a - b);
    const options = owned.flatMap((dex) => [
      { dex, shiny: false, label: pokemonName(dex) },
      ...(s.shiny[String(dex)] ? [{ dex, shiny: true, label: `✦ ${pokemonName(dex)}` }] : []),
    ]);
    const favs = s.profile.favourites;
    const favSelects = [0, 1, 2].map((i) => {
      const cur = favs[i];
      const sel = h(
        'select',
        {
          class: 'field',
          'aria-label': t('profile.chooseFavorite', { 0: i + 1 }),
          dataset: { testid: `fav-${i}` },
        },
        h('option', { value: '' }, '—'),
        options.map((o) =>
          h(
            'option',
            {
              value: `${o.dex}:${o.shiny ? 1 : 0}`,
              selected: !!cur && cur.dex === o.dex && cur.shiny === o.shiny,
            },
            o.label,
          ),
        ),
      );
      sel.addEventListener('change', () => {
        const next = favSelects
          .map((x) => x.value)
          .filter(Boolean)
          .map((v) => {
            const [dex, shiny] = v.split(':');
            return { dex: Number(dex), shiny: shiny === '1' };
          })
          .filter(
            (f, k, arr) => arr.findIndex((g) => g.dex === f.dex && g.shiny === f.shiny) === k,
          );
        void app.act(null, async () => {
          app.setSave(await app.api.setProfile({ favourites: next }));
          renderProfile();
        });
      });
      return sel;
    });
    const titleSel = h(
      'select',
      { class: 'field', dataset: { testid: 'title' } },
      h('option', { value: '' }, '—'),
      titled.map((a) =>
        h('option', { value: a.id, selected: s.profile.title === a.id }, a.title ?? ''),
      ),
    );
    titleSel.addEventListener('change', () => {
      void app.act(null, async () =>
        app.setSave(await app.api.setProfile({ title: titleSel.value || null })),
      );
    });
    replace(
      body,
      h('p', { class: 'sub' }, t('profile.thisIsHowOtherPlayers')),
      h('h3', null, app.user?.username ?? ''),
      h('h4', null, t('profile.your3FavoritePokemon')),
      h(
        'div',
        { class: 'fav-slots' },
        favSelects.map((sel, i) =>
          h(
            'label',
            { class: 'fav-slot' },
            favs[i] ? sprite(favs[i].dex, { scale: 2, shiny: favs[i].shiny }) : null,
            sel,
          ),
        ),
      ),
      h('h4', null, t('profile.title')),
      titled.length
        ? titleSel
        : h('p', { class: 'muted' }, t('profile.unlockAchievementsToEarnTitles')),
      h(
        'div',
        { class: 'prof-marks' },
        h(
          'div',
          null,
          h('span', null, t('profile.bestTime')),
          h('b', null, mmss(s.stats.bestTimeS)),
        ),
        h(
          'div',
          null,
          h('span', null, t('profile.inAGroup')),
          h('b', null, mmss(s.stats.bestGroupTimeS)),
        ),
        h('div', null, h('span', null, t('menu.bestLevel')), h('b', null, num(s.stats.bestLevel))),
      ),
    );
  };

  show();
  return { el: box.el };
}
