// The room (multiplayer lobby): members with their partner, ready / not-ready / busy and
// connection, invites, kick, leave, and the owner's start button, disabled while anyone blocks
// (the server's `blockers`). When the game loads, the app moves to the play screen.
// "Change Pokémon" on your card opens the Pokémon picker in place of the room (Back returns): the
// pick becomes the partner in the save, and the server shows it to the room. Not during a game.
import { t } from '@pokesurvivor/data';
import type { MemberStatus, RoomView } from '@pokesurvivor/protocol';
import type { App, Screen } from '../app/app.js';
import type { FriendsList } from '../app/api.js';
import { audio } from '../audio.js';
import { h, pokemonName, replace, sprite } from '../app/dom.js';
import { pokemonPicker, type PokemonPicker } from '../app/pokemon-picker.js';
import { toast } from '../app/toast.js';
import { activityLine, dotClass, inviteButton, presenceOf, tickActivities } from './friends.js';
import { screenBox } from './common.js';

const PLAYER_COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8'];

export const statusLabel = (s: MemberStatus): string =>
  ({ ready: t('app.ready'), 'not-ready': t('app.notReady'), busy: t('app.busy') })[s];

export function lobbyScreen(app: App): Screen {
  const leave = h(
    'button',
    { class: 'btn small ghost', dataset: { testid: 'room-leave' } },
    t('friends.leaveTheRoom'),
  );
  const box = screenBox(app, {
    id: 'lobby',
    title: t('friends.room'),
    extra: [leave],
    onBack: () => (picker ? closePicker() : app.go('menu')),
  });
  const content = h('div', { class: 'lobby-content' });
  box.body.append(content);
  let friends: FriendsList | null = null;
  let picker: PokemonPicker | null = null;

  const inGame = () => app.net?.roomView?.phase !== 'lobby';

  const openPicker = () => {
    if (picker || inGame()) return;
    const p = pokemonPicker(app, {
      id: 'room',
      confirm: {
        label: (_, __, isPartner) => (isPartner ? t('picker.itSYourPokemon') : t('picker.choose')),
        blocked: (_, __, isPartner) =>
          inGame() ? t('picker.gameInProgress') : isPartner ? '' : null,
        onConfirm: (mon, shiny, button) => {
          void app.act(button, async () => {
            if (inGame()) return;
            app.setSave(await app.api.setPartner(mon.dex, shiny));
            audio.sfx('confirm');
            toast(t('picker.isNowYourPokemon', { 0: mon.name }), 'good');
            closePicker();
          });
        },
      },
    });
    picker = p;
    box.title.textContent = t('picker.title');
    box.el.classList.add('picking');
    leave.classList.add('hidden');
    replace(content, p.el);
  };

  const closePicker = () => {
    if (!picker) return;
    picker.destroy();
    picker = null;
    box.title.textContent = t('friends.room');
    box.el.classList.remove('picking');
    render();
    // Back on the room, the gamepad starts from the button that opened the picker.
    content.querySelector<HTMLElement>('[data-testid="room-change-partner"]')?.focus();
  };

  leave.addEventListener('click', () => {
    void app.act(leave, async () => {
      await app.net?.leaveRoom();
      app.go('menu');
    });
  });

  const memberCard = (room: RoomView, index: number) => {
    const m = room.members[index];
    const me = app.user?.id;
    if (!m) return h('div', { class: 'lob-card empty' }, t('friends.free'));
    const color = PLAYER_COLORS[index] ?? '#fff';
    const kick =
      room.ownerId === me && m.userId !== me && room.phase === 'lobby'
        ? h(
            'button',
            { class: 'btn small ghost', dataset: { testid: `kick-${m.username}` } },
            t('app.kick'),
          )
        : null;
    kick?.addEventListener(
      'click',
      () => void app.act(kick, () => app.net?.kick(m.userId) ?? Promise.resolve()),
    );
    const change =
      m.userId === me
        ? h(
            'button',
            {
              class: 'btn small',
              disabled: room.phase !== 'lobby',
              dataset: { testid: 'room-change-partner' },
              on: { click: openPicker },
            },
            t('picker.change'),
          )
        : null;
    return h(
      'div',
      {
        class: ['lob-card', `st-${m.status}`],
        style: { '--pc': color },
        dataset: { testid: `member-${m.username}` },
      },
      m.partner
        ? sprite(m.partner.dex, {
            scale: 2,
            lively: true,
            shiny: m.partner.shiny,
            fit: { width: 140, height: 96 },
            feet: true,
          })
        : h('span', { class: 'no-partner' }, '?'),
      h('b', null, m.username),
      h('small', null, m.partner ? pokemonName(m.partner.dex) : t('app.noPartner')),
      h(
        'small',
        null,
        m.userId === room.ownerId ? `♛ ${t('friends.host')}` : '',
        m.userId === me ? ` · ${t('friends.you')}` : '',
      ),
      h(
        'span',
        { class: ['status-chip', m.status], dataset: { testid: 'member-status' } },
        statusLabel(m.status),
      ),
      h(
        'span',
        { class: ['conn', !m.connected && 'wait'] },
        m.connected ? t('friends.connected') : t('app.disconnected'),
      ),
      change,
      kick,
    );
  };

  const render = () => {
    const net = app.net;
    const room = net?.roomView;
    if (!net) return;
    if (picker) {
      // Picking: the room's changes only reach the confirm button (a game starting turns it off).
      if (room) return picker.refresh();
      closePicker();
      return;
    }
    leave.classList.toggle('hidden', !room);
    if (!room) {
      const create = h(
        'button',
        { class: 'btn primary', dataset: { testid: 'room-create' } },
        t('app.createRoom'),
      );
      create.addEventListener(
        'click',
        () => void app.act(create, () => net.createRoom().then(render)),
      );
      replace(
        content,
        h('p', { class: 'sub' }, t('app.lobbyIntro', { 0: 4 })),
        h(
          'div',
          { class: 'row' },
          create,
          h(
            'button',
            { class: 'btn ghost', on: { click: () => app.go('friends') } },
            t('menu.friends'),
          ),
        ),
      );
      return;
    }
    const me = room.members.find((m) => m.userId === app.user?.id);
    const owner = room.ownerId === app.user?.id;
    const ownerName = room.members.find((m) => m.userId === room.ownerId)?.username ?? '';
    const ready = me?.status === 'ready';
    const readyBtn = h(
      'button',
      {
        class: ['btn', 'grow', !ready && 'primary'],
        disabled: room.phase !== 'lobby',
        dataset: { testid: 'room-ready' },
      },
      ready ? t('app.notReadyAction') : t('app.readyAction'),
    );
    readyBtn.addEventListener(
      'click',
      () => void app.act(readyBtn, () => net.setStatus(ready ? 'not-ready' : 'ready')),
    );
    const blockers = room.blockers;
    const start = owner
      ? h(
          'button',
          {
            class: 'btn primary grow',
            disabled: room.phase !== 'lobby' || blockers.length > 0,
            dataset: { testid: 'room-start' },
          },
          room.phase === 'lobby' ? t('friends.startGame') : t('app.starting'),
        )
      : null;
    start?.addEventListener('click', () => void app.act(start, () => net.start()));

    // Online friends to invite (owner only).
    const invitable = owner
      ? (friends?.friends ?? [])
          .filter((f) => !room.members.some((m) => m.username === f.username))
          .map((f) => {
            const p = presenceOf(app, f);
            return h(
              'div',
              { class: 'fr-row' },
              h('span', { class: ['dot', dotClass(p)] }),
              h(
                'div',
                { class: 'grow' },
                h('b', null, f.username),
                activityLine(app, f.username, p),
              ),
              inviteButton(app, f.username, p),
            );
          })
      : [];

    replace(
      content,
      h(
        'p',
        { class: 'sub' },
        owner
          ? t('friends.youReTheHostInvite', { 0: room.maxMembers - 1 })
          : t('friends.youReInSRoom', { 0: ownerName }),
      ),
      h(
        'div',
        { class: 'lobby-members' },
        Array.from({ length: room.maxMembers }, (_, i) => memberCard(room, i)),
      ),
      room.phase !== 'lobby'
        ? h(
            'p',
            { class: 'note gold' },
            t('app.gameInProgress'),
            ' ',
            app.game
              ? h(
                  'button',
                  { class: 'btn small gold', on: { click: () => app.go('play') } },
                  t('app.backToGame'),
                )
              : null,
          )
        : blockers.length
          ? h(
              'p',
              { class: 'note blockers', dataset: { testid: 'blockers' } },
              t('app.waitingFor', { 0: blockers.join(', ') }),
            )
          : h('p', { class: 'note' }, t('friends.theGameStartsForEveryone')),
      h('div', { class: 'row', style: 'margin-top:12px' }, readyBtn, start),
      owner
        ? [
            h('h3', { style: 'margin:14px 0 6px' }, t('friends.inviteFriends')),
            h(
              'div',
              { class: 'fr-list' },
              invitable.length
                ? invitable
                : h('p', { class: 'sub' }, t('friends.noFriendsOnlineRightNow')),
            ),
          ]
        : null,
    );
  };

  const loadFriends = () =>
    app.api.friends().then(
      (l) => {
        friends = l;
        render();
      },
      () => {},
    );
  void loadFriends();
  render();
  const offs = [
    app.net?.on('room', render),
    app.net?.on('presence', render),
    app.events.on('friends', () => void loadFriends()),
    tickActivities(app, content),
  ];
  return {
    el: box.el,
    destroy: () => {
      picker?.destroy();
      offs.forEach((o) => o?.());
    },
  };
}
