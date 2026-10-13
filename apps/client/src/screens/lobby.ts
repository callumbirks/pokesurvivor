// The room (multiplayer lobby): members with their partner, ready / not-ready / busy and
// connection, invites, kick, leave, and the owner's start button, disabled while anyone blocks
// (the server's `blockers`). When the game loads, the app moves to the play screen.
import { t } from '@pokesurvivor/data';
import type { MemberStatus, RoomView } from '@pokesurvivor/protocol';
import type { App, Screen } from '../app/app.js';
import type { FriendsList } from '../app/api.js';
import { h, pokemonName, replace, sprite } from '../app/dom.js';
import { inviteButton, presenceOf } from './friends.js';
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
  const box = screenBox(app, { id: 'lobby', title: t('friends.room'), extra: [leave] });
  const content = h('div');
  box.body.append(content);
  let friends: FriendsList | null = null;

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
    return h(
      'div',
      {
        class: ['lob-card', `st-${m.status}`],
        style: { '--pc': color },
        dataset: { testid: `member-${m.username}` },
      },
      m.partner
        ? sprite(m.partner.dex, { scale: 2, lively: true, shiny: m.partner.shiny })
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
      kick,
    );
  };

  const render = () => {
    const net = app.net;
    const room = net?.roomView;
    if (!net) return;
    leave.classList.toggle('hidden', !room);
    if (!room) {
      const create = h(
        'button',
        { class: 'btn gold', dataset: { testid: 'room-create' } },
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
        class: ['btn', 'grow', !ready && 'gold'],
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
            class: 'btn gold grow',
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
              h('span', { class: ['dot', p !== 'offline' && 'on'] }),
              h('b', { class: 'grow' }, f.username),
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
        ? h('p', { class: 'note gold' }, t('app.gameInProgress'))
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
  ];
  return { el: box.el, destroy: () => offs.forEach((o) => o?.()) };
}
