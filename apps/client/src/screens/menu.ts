// Main menu: the partner on the left, the menu list on the right (legacy menu.js). Above the
// list, a solo run left unfinished in this browser (closed tab, crash, reload): resume or end it.
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import type { Save } from '../app/api.js';
import type { SavedSoloRun } from '../app/game.js';
import { endSavedRun, resumeSolo, savedSoloRun } from '../app/solo-runs.js';
import {
  gameData,
  h,
  icon,
  mmss,
  num,
  pokemonName,
  replace,
  sprite,
  rarityBall,
  typeChip,
  typeColor,
} from '../app/dom.js';

/** Missions done but not claimed yet. */
export function rewardsToClaim(save: Save): number {
  return [...save.missions.daily.missions, ...save.missions.weekly.missions].filter(
    (m) => !m.claimed && m.progress >= m.goal,
  ).length;
}

/** The menu's pixel-art icons (legacy menu.js; legacy had no separate multiplayer entry). */
const MENU_ICON: Record<string, string> = {
  solo: 'ball',
  lobby: 'friends',
  collection: 'book',
  gacha: 'ball4',
  shop: 'up',
  goals: 'medal3',
  ranking: 'trophy',
  friends: 'user',
  settings: 'gear',
};

export function menuScreen(app: App): Screen {
  const left = h('div', { class: 'menu-left' });
  const list = h('nav', { class: 'menu-list' });
  const savedBox = h('div', { class: 'box saved-run hidden', dataset: { testid: 'saved-run' } });
  const right = h(
    'div',
    { class: 'menu-right' },
    h('div', null, savedBox, h('div', { class: 'box' }, list)),
  );
  const el = h(
    'section',
    { class: 'scr scr-menu', dataset: { testid: 'screen-menu' } },
    left,
    right,
  );

  const item = (
    go: string,
    label: string,
    sub: string,
    opts: { play?: boolean; gold?: boolean; disabled?: boolean; onClick?: () => void } = {},
  ) =>
    h(
      'button',
      {
        class: ['menu-item', opts.play && 'play'],
        disabled: !!opts.disabled,
        dataset: { testid: `menu-${go}` },
        on: { click: opts.onClick ?? (() => app.go(go)) },
      },
      h('span', { class: 'mi-ico' }, MENU_ICON[go] ? icon(MENU_ICON[go], 26) : null),
      label,
      h('small', { class: opts.gold ? 'gold' : undefined }, sub),
    );

  const render = () => {
    const s = app.save;
    if (!s) return;
    const dex = s.partner.dex ?? 0;
    const mon = gameData().pokemonByDex.get(dex);
    const ownsShiny = !!s.shiny[String(dex)];
    const shiny = s.partner.shiny && ownsShiny;
    const setShiny = (v: boolean) => {
      if (v === shiny) return;
      void app.act(null, async () => app.setSave(await app.api.setPartner(dex, v)));
    };
    replace(
      left,
      h(
        'div',
        { class: 'logo' },
        h('div', { class: 't1' }, 'PokéSurvivor'),
        h('div', { class: 't2' }, t('login.mysteryDungeon')),
      ),
      h(
        'div',
        { class: 'partner-card' },
        h(
          'button',
          {
            class: ['stage', 'big', shiny && 'shiny'],
            style: { '--stage-c': shiny ? '#9ae6ff' : typeColor(mon?.types[0] ?? 'normal') },
            title: t('collection.chooseAsPartner', { 0: '' }),
            on: { click: () => app.go('collection', { dex: String(dex) }) },
          },
          sprite(dex, {
            scale: 4,
            lively: true,
            shiny,
            fit: { width: 256, height: 170 },
            feet: true,
          }),
        ),
        h(
          'div',
          { class: 'nm', dataset: { testid: 'partner-name' } },
          pokemonName(dex),
          shiny ? [' ', icon('shiny', 24)] : null,
        ),
        h(
          'div',
          { class: 'lv' },
          ...(mon?.types.map(typeChip) ?? []),
          ' ',
          mon ? rarityBall(mon.rarity, 12) : null,
        ),
        ownsShiny
          ? h(
              'div',
              { class: 'seg' },
              h(
                'button',
                { class: !shiny ? 'on' : undefined, on: { click: () => setShiny(false) } },
                t('app.normal'),
              ),
              h(
                'button',
                { class: shiny ? 'on' : undefined, on: { click: () => setShiny(true) } },
                icon('shiny', 12),
                ' ',
                t('app.shiny'),
              ),
            )
          : null,
      ),
      h(
        'div',
        { class: 'menu-stats' },
        `${t('menu.runs')} `,
        h('b', null, num(s.stats.runs)),
        ` · ${t('profile.bestTime')} `,
        h('b', null, mmss(s.stats.bestTimeS)),
        h('br'),
        `${t('menu.bestLevel')} `,
        h('b', null, num(s.stats.bestLevel)),
        ` · ${t('pause.defeated')} `,
        h('b', null, num(s.stats.totalKills)),
      ),
    );

    const owned = Object.keys(s.owned).length;
    const shinies = Object.keys(s.shiny).length;
    const total = gameData().pokedex.length;
    const pending = rewardsToClaim(s);
    const room = app.net?.roomView;
    const friends = [...(app.net?.friends.values() ?? [])];
    const online = friends.filter((f) => f !== 'offline').length;
    replace(
      list,
      // A player in a party plays with it: no solo runs until they leave the room.
      item('solo', t('app.solo'), room ? t('app.leaveRoomForSolo') : t('menu.enterTheDungeon'), {
        play: true,
        disabled: !!room,
      }),
      item(
        'lobby',
        t('app.multiplayer'),
        room
          ? t('menu.backToYourRoom', { 0: `${room.members.length}/${room.maxMembers}` })
          : t('menu.playInAGroupUp'),
        { gold: !!room },
      ),
      item(
        'collection',
        t('menu.pokemon'),
        `${owned} / ${total}${shinies ? ` · ${shinies} ✦` : ''}`,
      ),
      item('gacha', t('gacha.gacha'), t('menu.n9RegionsPokemonAndShinies')),
      item('shop', t('menu.upgrades'), t('menu.makeEveryRunStronger')),
      item(
        'goals',
        t('menu.missions'),
        pending
          ? t(pending === 1 ? 'menu.rewardToClaim' : 'menu.rewardsToClaim', { 0: pending })
          : t('menu.missionsAchievementsAndProfile'),
        { gold: pending > 0 },
      ),
      item('ranking', t('menu.leaderboard'), t('menu.whoSurvivesLongest')),
      item(
        'friends',
        t('menu.friends'),
        online ? t('menu.online', { 0: online }) : t('menu.playInAGroupUp'),
      ),
      item('settings', t('menu.settings'), t('menu.soundGraphicsControlsAndAccount')),
      item('logout', t('menu.logOut'), app.user?.username ?? '', {
        onClick: () => void app.logout(),
      }),
    );
  };

  const renderSaved = (saved: SavedSoloRun | null) => {
    savedBox.classList.toggle('hidden', !saved);
    if (!saved) return;
    const info = {
      0: pokemonName(saved.loadout.dex),
      1: mmss(saved.summary.durationS),
      2: saved.summary.level,
    };
    const resume = h(
      'button',
      { class: 'btn gold small grow', dataset: { testid: 'saved-run-resume' } },
      t('app.savedRunResume'),
    );
    resume.addEventListener('click', () => {
      void app.act(resume, async () => {
        if (!(await resumeSolo(app, saved))) renderSaved(null);
      });
    });
    const end = h(
      'button',
      { class: 'btn small grow', dataset: { testid: 'saved-run-end' } },
      t('app.savedRunEnd'),
    );
    end.addEventListener('click', () => {
      void app.act(end, async () => {
        await endSavedRun(app, saved);
        renderSaved(null);
      });
    });
    replace(
      savedBox,
      h('h4', null, t('app.savedRun')),
      h('p', { class: 'sub' }, t(saved.state ? 'app.savedRunInfo' : 'app.savedRunEnded', info)),
      h('div', { class: 'row' }, saved.state ? resume : null, end),
    );
  };

  render();
  void savedSoloRun(app).then(renderSaved);
  const offs = [
    app.events.on('save', render),
    app.net?.on('room', render),
    app.net?.on('presence', render),
  ];
  return { el, destroy: () => offs.forEach((off) => off?.()) };
}
