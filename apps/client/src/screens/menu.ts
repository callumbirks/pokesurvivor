// Main menu, in Mystery Dungeon windows on the living world: the title, the partner's window
// with What's new under it, the menu list on the right, and the partner in a dialogue box at the
// bottom explaining the highlighted entry. Above What's new, a solo run left unfinished in this
// browser (closed tab, crash, reload): resume or end it.
import { latestRelease, loadChangelog, t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import type { Save } from '../app/api.js';
import type { SavedSoloRun } from '../app/game.js';
import { endSavedRun, resumeSolo, savedSoloRun } from '../app/solo-runs.js';
import { hasUnseenRelease } from '../changelog.js';
import { settings } from '../settings.js';
import {
  CursorList,
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
import { keyHints } from './common.js';
import { prestigeOf, stars } from '../app/prestige.js';

/** Missions done but not claimed yet. */
export function rewardsToClaim(save: Save): number {
  return [...save.missions.daily.missions, ...save.missions.weekly.missions].filter(
    (m) => !m.claimed && m.progress >= m.goal,
  ).length;
}

/** The menu's pixel-art icons (original implementation; legacy had no separate multiplayer entry). */
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

/**
 * What's new, under the partner's window: the newest version, and a dot until it has been seen
 * on this device. It never opens the changelog by itself. `changelog.json` `whatsNewTheme`
 * (temporary, switched off by hand) gives it a theme: `mega` is charcoal with the Mega Evolution
 * rainbow for its inner border and the Mega symbol.
 */
export function whatsNewButton(app: App, changelog = loadChangelog()): HTMLElement {
  const latest = latestRelease(changelog);
  const unseen = hasUnseenRelease(changelog);
  const mega = changelog.whatsNewTheme === 'mega';
  return h(
    'button',
    {
      class: [
        'win',
        !mega && 'hot',
        'whats-new',
        unseen && 'unseen',
        mega && 'theme-mega',
        mega && settings.get().calmMode && 'calm',
      ],
      dataset: { testid: 'menu-changelog', talk: 'whatsNew' },
      on: { click: () => app.go('changelog') },
    },
    icon(mega ? 'mega' : 'star', 20),
    t('changelog.whatsNew'),
    latest ? ` · v${latest.version}` : null,
    unseen
      ? h('span', {
          class: 'new-dot',
          role: 'img',
          'aria-label': t('changelog.newUpdate'),
          title: t('changelog.newUpdate'),
          dataset: { testid: 'menu-changelog-dot' },
        })
      : null,
  );
}

export function menuScreen(app: App): Screen {
  const partnerWin = h('section', { class: 'win partner-win' });
  const savedBox = h('div', {
    class: 'win saved-run hidden',
    dataset: { testid: 'saved-run', talk: 'savedRun' },
  });
  const whatsNew = h('div', { class: 'whats-new-slot' });
  const nav = h('nav', { class: 'win menu-win', 'aria-label': t('menu.menu') });
  const portrait = h('div', { class: 'portrait' });
  const who = h('div', { class: 'who' });
  const say = h('p', { class: 'say', 'aria-live': 'polite' });
  const talkBox = h(
    'div',
    { class: 'win talk talk-box', dataset: { testid: 'menu-talk' } },
    portrait,
    h('div', null, who, say),
    h('span', { class: 'more' }),
  );
  const el = h(
    'section',
    { class: 'scr scr-menu', dataset: { testid: 'screen-menu' } },
    h(
      'header',
      { class: 'menu-title' },
      h('h1', { class: 'field-title' }, 'PokéSurvivor'),
      h('p', null, t('login.mysteryDungeon')),
    ),
    h('div', { class: 'menu-left' }, partnerWin, savedBox, whatsNew),
    nav,
    talkBox,
    keyHints([
      [['Enter'], ['a'], t('menu.choose')],
      [['↑', '↓'], ['dpadV'], t('menu.move')],
    ]),
  );

  /** The partner's line for each entry (`data-talk`), filled in on every render. */
  let lines: Record<string, string> = {};
  const speak = (key: string | undefined) => {
    say.textContent = (key && lines[key]) || lines.solo || '';
  };
  const list = new CursorList(nav, {
    navDefault: true,
    onSelect: (item) => speak(item.dataset.talk),
  });
  // What's new, the saved run and the partner explain themselves too.
  const talkAbout = (e: Event) => {
    const target =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-talk]') : null;
    if (target && !target.classList.contains('cursor-item')) speak(target.dataset.talk);
  };
  el.addEventListener('pointerover', talkAbout);
  el.addEventListener('focusin', talkAbout);

  const item = (
    go: string,
    label: string,
    opts: {
      extra?: Node | null;
      disabled?: boolean;
      hint?: string;
      talk?: string;
      onClick?: () => void;
    } = {},
  ) =>
    h(
      'button',
      {
        class: ['menu-item', 'cursor-item', go === 'logout' && 'dim'],
        disabled: !!opts.disabled,
        dataset: { testid: `menu-${go}`, talk: opts.talk ?? go },
        on: { click: opts.onClick ?? (() => app.go(go)) },
      },
      h('span', { class: 'mi-ico' }, MENU_ICON[go] ? icon(MENU_ICON[go], 24) : null),
      h('span', { class: 'mi-label' }, label),
      opts.extra ?? null,
      // Why it's disabled, for screen readers (the partner can't explain an entry that can't be
      // highlighted).
      opts.hint ? h('span', { class: 'sr-only' }, opts.hint) : null,
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
    const name = pokemonName(dex);
    replace(
      partnerWin,
      h(
        'button',
        {
          class: ['stage', shiny && 'shiny'],
          title: t('collection.chooseAsPartner', { 0: '' }),
          dataset: { talk: 'partner' },
          on: { click: () => app.go('collection', { dex: String(dex) }) },
        },
        sprite(dex, {
          scale: 5,
          lively: true,
          shiny,
          fit: { width: 276, height: 230 },
          feet: true,
        }),
      ),
      h(
        'div',
        { class: 'partner-info' },
        h(
          'h2',
          { dataset: { testid: 'partner-name' } },
          name,
          shiny ? [' ', icon('shiny', 24)] : null,
          dex ? [' ', stars(prestigeOf(s, dex))] : null,
        ),
        h(
          'div',
          { class: 'no' },
          t('menu.partnerNo', { 0: String(dex).padStart(3, '0') }),
          mon ? [' ', rarityBall(mon.rarity, 12)] : null,
        ),
        h('div', { class: 'types' }, ...(mon?.types.map(typeChip) ?? [])),
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
        h(
          'dl',
          { class: 'menu-stats' },
          h('dt', null, t('menu.runs')),
          h('dd', null, num(s.stats.runs)),
          h('dt', null, t('profile.bestTime')),
          h('dd', null, mmss(s.stats.bestTimeS)),
          h('dt', null, t('menu.bestLevel')),
          h('dd', null, num(s.stats.bestLevel)),
          h('dt', null, t('pause.defeated')),
          h('dd', null, num(s.stats.totalKills)),
        ),
      ),
    );
    replace(whatsNew, whatsNewButton(app));
    // Centred and fitted to the frame, whatever the sprite's shape (wide Regieleki, tall Wailord).
    replace(portrait, sprite(dex, { scale: 3, shiny, fit: { width: 84, height: 84 } }));
    portrait.style.setProperty('--portrait', typeColor(mon?.types[0] ?? 'normal'));
    who.textContent = name;

    const owned = Object.keys(s.owned).length;
    const total = gameData().pokedex.length;
    const pending = rewardsToClaim(s);
    const room = app.net?.roomView;
    const friends = [...(app.net?.friends.values() ?? [])];
    const online = friends.filter((f) => f !== 'offline').length;
    const roomSize = room ? `${room.members.length}/${room.maxMembers}` : '';
    lines = {
      solo: t('menu.talk.solo'),
      lobby: room ? t('menu.talk.lobbyInRoom', { 0: roomSize }) : t('menu.talk.lobby'),
      collection: t('menu.talk.collection', { 0: num(owned), 1: num(total) }),
      gacha: t('menu.talk.gacha'),
      shop: t('menu.talk.shop'),
      goals: pending
        ? pending === 1
          ? t('menu.talk.goalsReady')
          : t('menu.talk.goalsReadyMany', { 0: pending })
        : t('menu.talk.goals'),
      ranking: t('menu.talk.ranking'),
      friends: online ? t('menu.talk.friendsOnline', { 0: online }) : t('menu.talk.friends'),
      settings: t('menu.talk.settings'),
      logout: t('menu.talk.logout', { 0: app.user?.username ?? '' }),
      whatsNew: t('menu.talk.whatsNew'),
      partner: t('menu.talk.partner'),
      savedRun: t('menu.talk.savedRun'),
    };

    const solo = item('solo', t('app.solo'), {
      // A player in a party plays with it: no solo runs until they leave the room.
      disabled: !!room,
      hint: room ? t('app.leaveRoomForSolo') : undefined,
    });
    const lobby = item('lobby', t('app.multiplayer'), {
      extra: room ? h('span', { class: 'badge gold' }, roomSize) : null,
    });
    replace(
      nav,
      solo,
      lobby,
      item('collection', t('menu.pokemon'), {
        extra: h('small', null, `${num(owned)}/${num(total)}`),
      }),
      item('gacha', t('gacha.gacha')),
      item('shop', t('menu.upgrades')),
      item('goals', t('menu.missions'), {
        extra: pending ? h('span', { class: 'badge' }, String(pending)) : null,
      }),
      item('ranking', t('menu.leaderboard')),
      item('friends', t('menu.friends'), {
        extra: online ? h('small', { class: 'online' }, `${online}`) : null,
      }),
      h('hr'),
      item('settings', t('menu.settings')),
      item('logout', t('menu.logOut'), { onClick: () => void app.logout() }),
    );
    list.refresh(room ? lobby : solo);
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
      { class: 'btn primary small grow', dataset: { testid: 'saved-run-resume' } },
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
      h('h3', null, t('app.savedRun')),
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
