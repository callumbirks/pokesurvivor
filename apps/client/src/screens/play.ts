// The play screen hosts a run: it hands the RoomConnection to the game client (`mountGame`),
// shows the coop loading countdown over it (who has loaded, until the server's deadline), and
// on exit goes back (leaving a coop game that's still running). Solo runs report themselves.
import { t } from '@pokesurvivor/data';
import type { App, Screen } from '../app/app.js';
import { mountGame } from '../app/game.js';
import { h, replace } from '../app/dom.js';
import { toast } from '../app/toast.js';
import { menuNav } from '../menu-nav.js';
import { settingsScreen } from './settings.js';

export function playScreen(app: App): Screen {
  const session = app.game;
  const el = h('section', { class: 'scr play', dataset: { testid: 'screen-play' } });
  if (!session) return { el };
  const { conn } = session;
  const stage = h('div', { class: 'game-host' });
  const loading = h('div', { class: 'loading-overlay box hidden', dataset: { testid: 'loading' } });
  el.append(stage, loading);
  let exited = false;

  const exit = () => {
    if (exited) return;
    exited = true;
    // Solo runs are reported by their connection when the sim ends, not here.
    if (session.kind === 'coop' && conn.phase !== 'ended' && app.net?.roomView) {
      // Quitting a coop run mid-game: leave the room (the server credits what was earned).
      void app.net.leaveRoom().catch(() => {});
      toast(t('app.leftTheGame'));
    }
    app.endGame();
  };

  // The pause menu's "Settings": the settings screen over the game, without leaving the route
  // (that would end the run). The room status isn't touched: busy only counts in the lobby.
  const openSettings = (onClose: () => void) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      popNav();
      view.destroy?.();
      view.el.remove();
    };
    const view = settingsScreen(app, undefined, {
      onBack: () => {
        close();
        onClose();
      },
    });
    view.el.classList.add('over-game');
    el.append(view.el);
    // Over the game's own scope: the gamepad moves through the settings (B is their back button).
    const popNav = menuNav.push({ root: view.el });
    return close;
  };

  // Coop: the game gets the socket and shows room notices itself (the shell then doesn't).
  const client = session.kind === 'coop' ? (app.net ?? undefined) : undefined;
  const handle = mountGame(stage, conn, { onExit: exit, openSettings, client });

  // Coop loading: the server waits for everyone's `game.loaded` until the deadline.
  let timer: ReturnType<typeof setInterval> | null = null;
  const renderLoading = () => {
    const room = app.net?.roomView;
    const show = session.kind === 'coop' && conn.phase === 'loading' && room?.phase === 'loading';
    loading.classList.toggle('hidden', !show);
    if (!show || !room) return;
    const left = room.loadingDeadline
      ? Math.max(0, Math.ceil((room.loadingDeadline - Date.now()) / 1000))
      : null;
    replace(
      loading,
      h('h3', null, t('login.loading')),
      h(
        'ul',
        { class: 'loading-list' },
        room.members
          .filter((m) => m.inGame)
          .map((m) =>
            h('li', { class: m.loaded ? 'ok' : undefined }, m.loaded ? '✓ ' : '… ', m.username),
          ),
      ),
      left !== null
        ? h(
            'p',
            { class: 'sub', dataset: { testid: 'loading-countdown' } },
            t('app.loadingDeadline', { 0: left }),
          )
        : null,
    );
  };
  renderLoading();
  timer = setInterval(renderLoading, 500);
  const offs = [app.net?.on('room', renderLoading), conn.on('phase', renderLoading)];

  return {
    el,
    destroy() {
      if (timer) clearInterval(timer);
      offs.forEach((o) => o?.());
      handle.dispose();
    },
  };
}
