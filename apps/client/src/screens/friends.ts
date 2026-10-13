// Friends: add by nickname, accept / decline requests, remove, live presence, and invites to
// your room. Requests and the list are HTTP; presence and invites come over the WebSocket.
import { t } from '@pokesurvivor/data';
import type { PresenceStatus } from '@pokesurvivor/protocol';
import type { App, Screen } from '../app/app.js';
import type { Friend, FriendsList } from '../app/api.js';
import { h, replace, sprite } from '../app/dom.js';
import { toast } from '../app/toast.js';
import { loadInto, screenBox } from './common.js';

export const presenceLabel = (p: PresenceStatus): string =>
  ({
    offline: t('friends.offline'),
    online: t('friends.online'),
    in_lobby: t('app.inALobby'),
    in_game: t('friends.playing'),
  })[p];

const dotClass = (p: PresenceStatus) =>
  ({ offline: '', online: 'on', in_lobby: 'on', in_game: 'play' })[p];

/** Live presence (WebSocket) if known, else what the HTTP list said. */
export function presenceOf(app: App, f: Friend): PresenceStatus {
  return app.net?.friends.get(f.username) ?? f.presence;
}

/** An "Invite" button for a friend, if there's a room to invite them to. */
export function inviteButton(
  app: App,
  username: string,
  presence: PresenceStatus,
): HTMLElement | null {
  const room = app.net?.roomView;
  if (!room || room.phase !== 'lobby' || room.ownerId !== app.user?.id) return null;
  if (room.members.some((m) => m.username === username))
    return h('span', { class: 'muted small' }, t('friends.inTheRoom'));
  const invited = room.invited.includes(username);
  const b = h(
    'button',
    {
      class: 'btn small gold',
      disabled: presence === 'offline' || invited || room.members.length >= room.maxMembers,
      dataset: { testid: `invite-${username}` },
    },
    invited ? t('friends.requestSent') : t('friends.invite'),
  );
  b.addEventListener('click', () => {
    void app.act(b, async () => {
      await app.net?.invite(username);
      toast(t('friends.inviteSentTo', { 0: username }), 'good');
    });
  });
  return b;
}

export function friendsScreen(app: App): Screen {
  const goRoom = h(
    'button',
    { class: 'btn small gold', on: { click: () => app.go('lobby') } },
    t('friends.goToTheRoom'),
  );
  const box = screenBox(app, { id: 'friends', title: t('menu.friends'), extra: [goRoom] });
  const input = h('input', {
    class: 'field grow',
    maxlength: 16,
    spellcheck: 'false',
    placeholder: t('friends.yourFriendSNickname'),
    dataset: { testid: 'friend-name' },
  });
  const add = h(
    'button',
    { class: 'btn gold', type: 'submit', dataset: { testid: 'friend-add' } },
    t('friends.addFriend'),
  );
  const form = h(
    'form',
    {
      class: 'row',
      autocomplete: 'off',
      on: {
        submit: (e) => {
          e.preventDefault();
          const name = input.value.trim();
          if (!/^[A-Za-z0-9_]{3,16}$/.test(name))
            return toast(t('friends.typeYourFriendSExact'), 'error');
          void app.act(add, async () => {
            const res = await app.api.addFriend(name);
            toast(
              res.status === 'accepted'
                ? t('friends.youReNowFriendsWith', { 0: name })
                : t('friends.requestSentTo', { 0: name }),
              'good',
            );
            input.value = '';
            reload();
          });
        },
      },
    },
    input,
    add,
  );
  const listEl = h('div', { class: 'fr-list', dataset: { testid: 'friends-list' } });
  box.body.append(
    h('p', { class: 'sub' }, t('friends.yourNicknameIs', { 0: app.user?.username ?? '' })),
    form,
    listEl,
  );
  let list: FriendsList | null = null;

  const render = () => {
    goRoom.classList.toggle('hidden', !app.net?.roomView);
    if (!list) return;
    const l = list;
    const rows: HTMLElement[] = [];
    for (const r of l.incoming) {
      const accept = h(
        'button',
        { class: 'btn small gold', dataset: { testid: `accept-${r.username}` } },
        t('friends.accept'),
      );
      accept.addEventListener(
        'click',
        () => void app.act(accept, async () => (await app.api.acceptFriend(r.username), reload())),
      );
      const decline = h('button', { class: 'btn small ghost' }, t('friends.decline'));
      decline.addEventListener(
        'click',
        () =>
          void app.act(decline, async () => (await app.api.declineFriend(r.username), reload())),
      );
      rows.push(
        h(
          'div',
          { class: 'fr-row' },
          h('span', { class: 'dot pend' }),
          h(
            'div',
            { class: 'grow' },
            h('b', null, r.username),
            h('div', { class: 'st' }, t('friends.wantsToBeYourFriend')),
          ),
          accept,
          decline,
        ),
      );
    }
    const order: Record<PresenceStatus, number> = {
      in_lobby: 0,
      online: 0,
      in_game: 1,
      offline: 2,
    };
    const friends = [...l.friends].sort(
      (a, b) =>
        order[presenceOf(app, a)] - order[presenceOf(app, b)] ||
        a.username.localeCompare(b.username),
    );
    for (const f of friends) {
      const p = presenceOf(app, f);
      const remove = h('button', { class: 'btn small ghost', title: t('friends.remove') }, '✕');
      remove.addEventListener('click', () => {
        if (!confirm(t('friends.removeFromYourFriends', { 0: f.username }))) return;
        void app.act(remove, async () => (await app.api.removeFriend(f.username), reload()));
      });
      rows.push(
        h(
          'div',
          { class: 'fr-row', dataset: { testid: `friend-${f.username}` } },
          h('span', { class: ['dot', dotClass(p)] }),
          f.partner
            ? h(
                'span',
                { class: 'mini' },
                sprite(f.partner.dex, {
                  scale: 1,
                  shiny: f.partner.shiny,
                  fit: { width: 40, height: 34 },
                  feet: true,
                }),
              )
            : null,
          h(
            'div',
            { class: 'grow' },
            h('b', null, f.username),
            h('div', { class: 'st', dataset: { testid: 'presence' } }, presenceLabel(p)),
          ),
          inviteButton(app, f.username, p),
          remove,
        ),
      );
    }
    for (const r of l.outgoing) {
      const cancel = h('button', { class: 'btn small ghost' }, t('friends.cancel'));
      cancel.addEventListener(
        'click',
        () => void app.act(cancel, async () => (await app.api.removeFriend(r.username), reload())),
      );
      rows.push(
        h(
          'div',
          { class: 'fr-row' },
          h('span', { class: 'dot' }),
          h(
            'div',
            { class: 'grow' },
            h('b', null, r.username),
            h('div', { class: 'st' }, t('friends.requestSent')),
          ),
          cancel,
        ),
      );
    }
    replace(listEl, rows.length ? rows : h('p', { class: 'sub' }, t('friends.youHavenTAddedAny')));
  };

  const reload = loadInto(
    listEl,
    () => app.api.friends(),
    (l) => {
      list = l;
      render();
    },
  );
  const offs = [
    app.events.on('friends', () => reload()),
    app.net?.on('presence', render),
    app.net?.on('room', render),
  ];
  render();
  return { el: box.el, destroy: () => offs.forEach((o) => o?.()) };
}
