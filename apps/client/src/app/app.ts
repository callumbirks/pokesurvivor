// The app shell: screen navigation (hash routes, so the browser's back button works), the
// session check on load, the save cache, the WebSocket connection with reconnect feedback, the
// top bar, invites, toasts and notices. Screens are plain functions that build a DOM subtree.
import { t, type UiStringKey } from '@pokesurvivor/data';
import {
  Emitter,
  NetClient,
  socketUrl,
  type ConnectionState,
  type Invite,
  type RoomConnection,
} from '@pokesurvivor/netclient';
import { CloseCode, type NoticeCode } from '@pokesurvivor/protocol';
import { audio } from '../audio.js';
import { settings, SYNCED_KEYS } from '../settings.js';
import {
  Api,
  ApiError,
  type GachaInfo,
  type Save,
  type UnlockedAchievement,
  type User,
} from './api.js';
import { MenuBackdrop } from './backdrop.js';
import { BusyStatus } from './busy.js';
import { clockText, everyTick } from '../game/countdown.js';
import { shellShowsNotice } from './notices.js';
import {
  gameData,
  h,
  icon,
  installIconCss,
  loadSprites,
  num,
  pokemonName,
  replace,
} from './dom.js';
import { mountToasts, notice, toast, toastError } from './toast.js';
import { UpdatePrompt } from './update-prompt.js';
import { setPublishedConfig } from '../live-config.js';

export interface Screen {
  el: HTMLElement;
  destroy?(): void;
}

export type ScreenFactory = (app: App, params: URLSearchParams) => Screen;

export interface Route {
  create: ScreenFactory;
  /** Sets the room status to `busy` while open (gacha, shop, collection, settings). */
  busy?: boolean;
  /** Reachable logged out (login). */
  public?: boolean;
  /** Reachable before choosing a starter (the starter screens themselves). */
  noPartner?: boolean;
  /** Shows the top bar (coins, tickets, gems, account). */
  topbar?: boolean;
  /** Admins only (`User.isAdmin`); for anyone else the route doesn't exist (the menu). */
  admin?: boolean;
}

/** What the play screen runs: a coop game from the server, or a solo run in the browser. */
export interface GameSession {
  conn: RoomConnection;
  kind: 'coop' | 'solo';
}

export interface AppEvents extends Record<string, unknown> {
  save: Save;
  /** The friends list changed (requests, removals): screens showing it should reload it. */
  friends: void;
}

export class App {
  readonly api = new Api();
  readonly events = new Emitter<AppEvents>();
  user: User | null = null;
  save: Save | null = null;
  net: NetClient | null = null;
  game: GameSession | null = null;
  readonly busy: BusyStatus;
  /** Offers a reload when the server runs a newer deploy than this page (not during runs). */
  readonly updates = new UpdatePrompt(__BUILD_ID__, {
    show: (version) => this.showUpdate(version),
    hide: () => notice('update', null),
  });

  private screen: Screen | null = null;
  private routeName = '';
  private readonly main: HTMLElement;
  private readonly backdrop: MenuBackdrop;
  private readonly topbar: HTMLElement;
  private readonly invitePop: HTMLElement;
  private gachaInfo: Promise<GachaInfo> | null = null;
  private netOffs: (() => void)[] = [];
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly routes: Record<string, Route>,
  ) {
    this.main = h('main', { class: 'screens' });
    this.topbar = h('header', { class: 'topbar hidden' });
    this.invitePop = h('div', { class: 'box invite-pop hidden', role: 'dialog' });
    root.append(this.main, this.topbar, this.invitePop);
    mountToasts(root);
    installIconCss();
    this.backdrop = new MenuBackdrop(root);
    this.busy = new BusyStatus({
      room: () => this.net?.roomView ?? null,
      selfId: () => this.user?.id ?? null,
      setStatus: (s) => this.net?.setStatus(s) ?? Promise.resolve(),
    });
    this.api.onUnauthenticated = () => {
      if (this.user) this.loggedOut(t('errors.sessionExpired'));
    };
    this.api.onBuild = (build, version) => this.updates.server(build, version);
    addEventListener('hashchange', () => this.render());
    // Settings changed here follow the account (debounced: sliders send many changes).
    settings.subscribe((_s, changed) => {
      if (!this.user || !changed.some((k) => (SYNCED_KEYS as readonly string[]).includes(k)))
        return;
      if (this.settingsTimer) clearTimeout(this.settingsTimer);
      this.settingsTimer = setTimeout(() => {
        void this.api.setSettings(settings.synced()).then(
          (save) => this.setSave(save),
          () => {}, // Kept locally; the next change retries.
        );
      }, 600);
    });
  }

  // ---------------------------------------------------------------- boot and session

  async boot(): Promise<void> {
    replace(this.main, h('div', { class: 'boot' }, t('login.loading')));
    try {
      const { user } = await this.api.me();
      await this.loggedIn(user);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        // The server is down or unreachable: say so and retry, rather than showing the login.
        replace(
          this.main,
          h(
            'div',
            { class: 'boot' },
            h('p', null, t('errors.network')),
            h('button', { class: 'btn', on: { click: () => void this.boot() } }, t('app.retry')),
          ),
        );
        return;
      }
      this.render();
    }
  }

  async loggedIn(user: User): Promise<void> {
    this.user = user;
    void loadSprites();
    this.refreshConfig(true);
    const save = await this.api.save();
    this.setSave(save);
    // The account's settings win over this browser's (they may come from another device).
    settings.set(save.settings);
    this.connect();
    this.render();
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch (err) {
      toastError(err);
      return;
    }
    this.loggedOut(null);
  }

  private loggedOut(message: string | null): void {
    this.disconnect();
    this.user = null;
    this.save = null;
    this.game = null;
    if (message) toast(message, 'error');
    this.go('login');
  }

  setSave(save: Save): void {
    this.save = save;
    this.renderTopbar();
    this.events.emit('save', save);
  }

  async refreshSave(): Promise<void> {
    try {
      this.setSave(await this.api.save());
    } catch {
      // Stale coins for a moment are fine; the next action refreshes it.
    }
  }

  private configAt = -Infinity;

  /**
   * Fetches the published live-tuning config, for the numbers the menus show (`gameData()`): at
   * login, then at most once a minute as screens open. Until it comes, the built-in data.
   */
  refreshConfig(force = false): void {
    if (!force && performance.now() - this.configAt < 60_000) return;
    this.configAt = performance.now();
    this.api.config().then(setPublishedConfig, () => {
      this.configAt = -Infinity; // Retried with the next screen.
    });
  }

  /** The gacha rules and banners (cached; pity changes come back with each pull). */
  gacha(): Promise<GachaInfo> {
    this.gachaInfo ??= this.api.gacha().catch((err: unknown) => {
      this.gachaInfo = null;
      throw err;
    });
    return this.gachaInfo;
  }

  /** Toasts for achievements a call unlocked (rewards are already in the returned save). */
  achievements(list: readonly UnlockedAchievement[]): void {
    const { achievementById } = gameData();
    for (const a of list) {
      const name = achievementById.get(a.id)?.name ?? a.id;
      toast(t('profile.achievement', { 0: name }), 'gold', 4500);
      if (a.title) toast(t('profile.newTitle', { 0: a.title }), 'gold', 4500);
    }
  }

  /**
   * Runs an action with a loading state on `button` (disabled, spinner) and a toast on error.
   * Resolves with the result, or undefined if it failed.
   */
  async act<T>(button: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T | undefined> {
    if (button?.classList.contains('loading')) return undefined;
    button?.classList.add('loading');
    if (button) button.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toastError(err);
      return undefined;
    } finally {
      button?.classList.remove('loading');
      if (button) button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- WebSocket

  private connect(): void {
    this.disconnect();
    const net = new NetClient({ url: socketUrl(location) });
    this.net = net;
    const on = <K extends Parameters<NetClient['on']>[0]>(
      event: K,
      fn: Parameters<typeof net.on<K>>[1],
    ) => this.netOffs.push(net.on(event, fn));
    on('state', (s) => this.connectionState(s));
    // Reconnecting after a deploy lands on the new server: its build tells us we're outdated. A
    // draining server is the old one, still finishing games.
    on('welcome', (w) => {
      if (!w.draining) this.updates.server(w.build, w.version);
    });
    on('room', () => {
      if (net.roomView) {
        notice('room-pending', null);
        if (this.waitingForRoom && this.routeName === 'menu') this.go('lobby');
        this.waitingForRoom = false;
      }
      this.busy.onRoom();
      this.renderTopbar();
    });
    on('online', () => this.renderTopbar());
    on('invite', () => this.renderInvite());
    on('invite.revoked', () => this.renderInvite());
    on('invite.declined', (d) => toast(t('app.declinedInvite', { 0: d.username })));
    on('notice', (n) => this.roomNotice(n.code, n.usernames ?? []));
    on('friend', (f) => {
      const key: Record<typeof f.event, UiStringKey> = {
        request_received: 'app.friendRequestReceived',
        request_accepted: 'friends.youReNowFriendsWith',
        friend_removed: 'app.friendRemoved',
      };
      toast(t(key[f.event], { 0: f.username }), f.event === 'friend_removed' ? 'info' : 'good');
      this.events.emit('friends', undefined);
    });
    // A coop game is loading (or resumed after a reload): hand it to the play screen.
    on('loading', ({ room }) => this.startGame({ conn: room, kind: 'coop' }));
    on('start', ({ room }) => {
      if (this.game?.conn !== room) this.startGame({ conn: room, kind: 'coop' });
    });
    on('results', () => void this.refreshSave());
  }

  private disconnect(): void {
    for (const off of this.netOffs) off();
    this.netOffs = [];
    this.net?.close();
    this.net = null;
    notice('connection', null);
    notice('room-pending', null);
    this.stopUpdateClock?.();
    this.stopUpdateClock = null;
    this.waitingForRoom = false;
    this.renderInvite();
  }

  private stopUpdateClock: (() => void) | null = null;

  /**
   * The server is stopping for an update: "Server update in 0:30", ticking down (in a solo run,
   * that it isn't affected; a coop game shows its own). Cleared once we're on a server that isn't.
   */
  private serverUpdateNotice(): void {
    this.stopUpdateClock?.();
    this.stopUpdateClock = null;
    const net = this.net;
    const at = net?.updateAt ?? null;
    if (at === null) {
      // An older server finishing its games (start-first drain), or none.
      notice('draining', net?.draining ? t('app.serverUpdating') : null, 'gold');
      return;
    }
    this.stopUpdateClock = everyTick(at, (now) => {
      const solo = this.routeName === 'play' && this.game?.kind === 'solo';
      const clock = clockText(at, now);
      const due = now >= at;
      notice(
        'draining',
        due
          ? t('app.serverUpdateNow')
          : t(solo ? 'app.serverUpdateSolo' : 'app.serverUpdate', { 0: clock }),
        'gold',
        due ? t('app.serverUpdateNow') : t('game.chipUpdate', { 0: clock }),
      );
    });
  }

  private connectionState(state: ConnectionState): void {
    const net = this.net;
    if (!net) return;
    if (state === 'open') {
      notice('connection', null);
      // A new server instance after a deploy isn't stopping: this clears the old notice.
      this.serverUpdateNotice();
    } else if (state === 'reconnecting') {
      // The update is under way: the reconnecting notice says it all now.
      if (net.updateAt !== null && Date.now() >= net.updateAt) {
        this.stopUpdateClock?.();
        this.stopUpdateClock = null;
        notice('draining', null);
      }
      notice('connection', t('app.reconnecting'), 'error', t('game.chipReconnecting'));
    } else if (state === 'failed') {
      const code = net.failure?.code;
      if (code === CloseCode.unauthenticated) {
        this.loggedOut(t('errors.sessionExpired'));
        return;
      }
      const reload = h(
        'button',
        { class: 'btn small', on: { click: () => location.reload() } },
        t('settings.reload'),
      );
      const text =
        code === CloseCode.superseded
          ? t('app.superseded')
          : code === CloseCode.versionMismatch
            ? t('app.newVersion')
            : t('app.connectionFailed');
      notice('connection', h('span', null, text, ' ', reload), 'error');
    }
    this.root.classList.toggle('game-notices', this.gameShowsNotices);
    this.renderTopbar();
  }

  /** The "new version" notice: reload now, or close it for a while. */
  private showUpdate(version: string): void {
    notice(
      'update',
      h(
        'span',
        { class: 'update-notice', dataset: { testid: 'update-notice' } },
        h('span', null, t('app.updateAvailable', { 0: version })),
        h(
          'span',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn primary small',
              dataset: { testid: 'update-reload' },
              on: { click: () => location.reload() },
            },
            t('settings.reload'),
          ),
          h(
            'button',
            {
              class: 'btn ghost small',
              title: t('profile.close'),
              'aria-label': t('profile.close'),
              dataset: { testid: 'update-dismiss' },
              on: { click: () => this.updates.dismiss() },
            },
            '✕',
          ),
        ),
      ),
    );
  }

  /** A multiplayer game is on screen: it shows room and connection notices itself. */
  get gameShowsNotices(): boolean {
    // A terminal failure needs the shell's reload button even while a run is on screen.
    return this.routeName === 'play' && this.game?.kind === 'coop' && this.net?.state !== 'failed';
  }

  private waitingForRoom = false;

  private roomNotice(code: NoticeCode, usernames: string[]): void {
    if (code === 'room-handoff-expired') {
      this.waitingForRoom = false;
      notice('room-pending', null);
      toast(t('notices.room-handoff-expired'));
      return;
    }
    if (code === 'room-handoff-pending') {
      this.waitingForRoom = true;
      notice('room-pending', t('notices.room-handoff-pending'), 'gold');
      return;
    }
    if (code === 'server-draining' || code === 'server-update') {
      // Sticky: kept (hidden during a coop game, which shows its own) so it's still there after.
      this.serverUpdateNotice();
      return;
    }
    if (!shellShowsNotice(code, this.gameShowsNotices)) return;
    const key = `notices.${code}` as UiStringKey;
    const text = t(key, { 0: usernames.join(', ') });
    if (text !== key)
      toast(text, code === 'kicked' || code === 'game-cancelled' ? 'error' : 'info');
    if (code === 'kicked' && this.routeName === 'lobby') this.go('menu');
  }

  // ---------------------------------------------------------------- invites

  private renderInvite(): void {
    const invite: Invite | undefined = [...(this.net?.invites.values() ?? [])].at(-1);
    const hidden = !invite || this.routeName === 'play';
    this.invitePop.classList.toggle('hidden', hidden);
    if (hidden || !invite) return;
    const net = this.net;
    if (!net) return;
    const join = h(
      'button',
      {
        class: 'btn primary small grow',
        dataset: { testid: 'invite-accept' },
        on: {
          click: () =>
            void this.act(join, async () => {
              if (net.roomView) await net.leaveRoom();
              await net.join(invite.roomId);
              this.renderInvite();
              this.go('lobby');
            }),
        },
      },
      t('friends.join'),
    );
    const decline = h(
      'button',
      {
        class: 'btn ghost small',
        dataset: { testid: 'invite-decline' },
        on: {
          click: () =>
            void this.act(decline, async () => {
              await net.declineInvite(invite.roomId);
              this.renderInvite();
            }),
        },
      },
      t('friends.noThanks'),
    );
    replace(
      this.invitePop,
      h(
        'div',
        { dataset: { testid: 'invite' } },
        icon('friends', 22),
        ' ',
        t('friends.invitesYouToPlayIn', { 0: invite.from }),
      ),
      h('div', { class: 'row', style: 'margin-top:10px' }, join, decline),
    );
  }

  // ---------------------------------------------------------------- games

  /** Opens the play screen for a run (coop from the server, or solo). */
  startGame(session: GameSession): void {
    this.game = session;
    if (this.routeName === 'play') this.render();
    else this.go('play');
  }

  /**
   * The play screen calls this when the player leaves the run or closes its results: back to
   * the lobby (coop, still in the room) or the menu, with the save refreshed.
   */
  endGame(): void {
    const kind = this.game?.kind;
    this.game = null;
    void this.refreshSave();
    this.go(kind === 'coop' && this.net?.roomView ? 'lobby' : 'menu');
  }

  // ---------------------------------------------------------------- navigation

  /** Navigates to a screen (a hash route, so back/forward work). */
  go(name: string, params?: Record<string, string>): void {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    const hash = `#${name}${query}`;
    if (location.hash === hash) this.render();
    else location.hash = hash;
  }

  private parseHash(): { name: string; params: URLSearchParams } {
    const raw = location.hash.replace(/^#/, '');
    const [name = '', query = ''] = raw.split('?');
    return { name, params: new URLSearchParams(query) };
  }

  /** Shows the screen for the current hash, applying the login and starter gates. */
  render(): void {
    let { name, params } = this.parseHash();
    let route = this.routes[name];
    const hasPartner = !!this.save && Object.keys(this.save.owned).length > 0;
    if (!this.user) name = route?.public ? name : 'login';
    else if (!hasPartner) name = route?.noPartner ? name : 'starter';
    else if (!route || route.public || route.noPartner || (route.admin && !this.user.isAdmin))
      name = 'menu';
    if (name === 'play' && !this.game) name = 'menu';
    route = this.routes[name];
    if (!route) return;
    if (`#${name}` !== location.hash.split('?')[0]) {
      history.replaceState(null, '', `#${name}`);
      params = new URLSearchParams();
    }
    this.screen?.destroy?.();
    this.routeName = name;
    this.busy.setBusyScreen(!!route.busy);
    // Runs (and their results) are never interrupted; the prompt waits for the menus.
    this.updates.screen(name === 'play');
    if (name !== 'play') this.refreshConfig();
    this.screen = route.create(this, params);
    // Menu music everywhere outside a run (it starts on the first click or key); the game plays
    // its own.
    if (name !== 'play') audio.music('village');
    this.main.replaceChildren(this.screen.el);
    this.main.dataset.screen = name;
    this.backdrop.show(name !== 'play');
    // The game shows its own sticky notices (connection, server updating) over the canvas.
    this.root.classList.toggle('game-notices', this.gameShowsNotices);
    this.topbar.classList.toggle('hidden', !route.topbar);
    this.renderTopbar();
    this.renderInvite();
  }

  get route(): string {
    return this.routeName;
  }

  private renderTopbar(): void {
    const s = this.save;
    if (!s || !this.user || this.topbar.classList.contains('hidden')) return;
    const room = this.net?.roomView;
    const state = this.net?.state;
    // Players online, beside the window: hidden until the server sends a count, and while offline.
    const online = state === 'open' ? (this.net?.onlineCount ?? null) : null;
    const card = h(
      'div',
      { class: 'tb-card win' },
      h('div', { class: 'tb-cell', title: t('app.coins') }, icon('coin', 18), num(s.coins)),
      h(
        'div',
        { class: 'tb-cell', title: t('app.tickets') },
        icon('ticket', 18),
        num(s.tickets.x1),
        icon('ticket10', 18),
        num(s.tickets.x10),
      ),
      h(
        'div',
        { class: 'tb-cell', title: t('app.gems'), dataset: { testid: 'topbar-gems' } },
        icon('gem', 18),
        num(s.gems ?? 0),
      ),
      room
        ? h(
            'button',
            { class: 'tb-cell room-cell', on: { click: () => this.go('lobby') } },
            t('app.roomPill', { 0: room.members.length, 1: room.maxMembers }),
          )
        : null,
      h(
        'div',
        { class: 'tb-cell user-cell', title: state ?? '' },
        h('i', { class: ['sync', state === 'open' ? 'ok' : 'offline'] }),
        this.user.username,
      ),
      h(
        'button',
        {
          class: 'tb-cell gear-cell',
          title: t('menu.settings'),
          'aria-label': t('menu.settings'),
          on: { click: () => this.go('settings') },
        },
        icon('gear', 20),
      ),
    );
    replace(
      this.topbar,
      online === null
        ? null
        : h(
            'div',
            {
              class: 'online-count',
              title: t('app.onlineTitle'),
              dataset: { testid: 'online-count' },
            },
            h('i', { class: 'online-dot', 'aria-hidden': 'true' }),
            // Narrow windows show just the number (styles.css).
            h('span', { class: 'online-full' }, t('app.onlineCount', { 0: num(online) })),
            h('span', { class: 'online-short' }, num(online)),
          ),
      card,
    );
  }

  /** The partner's name, for menus. */
  partnerName(): string {
    const dex = this.save?.partner.dex;
    return dex ? pokemonName(dex) : '';
  }
}
