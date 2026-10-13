// Dev-only test page for the in-game client (/play.html, or /?play-solo and /?play-net).
//   ?solo   (&t=<minutes> to start late, &god to be invulnerable, &seed=: dev runs, not credited;
//           in those, F/V/H/J/K/T/B trigger a rift, the arena, events and weather)
//           log in, then a solo run from your save's partner: loading, the run, the report to the
//           server and the results; then again.
//   ?net    log in, add a friend, make a room, invite, ready up and start: the run is played
//           through mountGame (use a private window or 127.0.0.1 for the second account).
// Like the other debug views, this page isn't part of the app (the app shell is 4b's).
import { NetClient, socketUrl, type NetRoomConnection } from '@pokesurvivor/netclient';
import type { PlayerConfig } from '@pokesurvivor/sim';
import type { RunSummary } from '@pokesurvivor/protocol';
import { createSoloConnection, mountGame, type GameHandle, type SoloApi } from '../index.js';

const root = document.querySelector<HTMLElement>('#play')!;
const params = new URLSearchParams(location.search);
const mode = params.has('net') || params.has('play-net') ? 'net' : 'solo';

const panel = document.createElement('div');
panel.style.cssText =
  'position:fixed;top:12px;right:12px;width:320px;max-height:94vh;overflow:auto;z-index:5;' +
  'background:rgba(0,0,0,.85);color:#eee;font:13px ui-monospace,monospace;padding:12px;border-radius:8px';
document.body.append(panel);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(method: string, url: string, body?: object) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, data };
}

function login(then: () => void): void {
  panel.style.display = '';
  panel.innerHTML = `<b>play (${mode}): log in</b><br><br>
    <input id="u" placeholder="username" style="width:95%"><br>
    <input id="p" placeholder="password (8+)" type="password" style="width:95%"><br><br>
    <button id="login">log in</button> <button id="register">register (+ Charmander)</button>
    <p id="err" style="color:#f88"></p>`;
  const value = (id: string) => panel.querySelector<HTMLInputElement>(`#${id}`)!.value;
  const go = async (path: string) => {
    const { ok, data } = await api('POST', `/api/auth/${path}`, {
      username: value('u'),
      password: value('p'),
    });
    if (!ok) {
      panel.querySelector('#err')!.textContent = JSON.stringify(data);
      return;
    }
    if (path === 'register') await api('POST', '/api/save/starter', { dex: 4 });
    then();
  };
  panel.querySelector('#login')!.addEventListener('click', () => void go('login'));
  panel.querySelector('#register')!.addEventListener('click', () => void go('register'));
}

// ---------------------------------------------------------------- solo

/** The app shell passes its `api.ts`; this page has its own small one. */
const devApi: SoloApi = {
  async startRun() {
    const { loadout } = await loadSoloLoadout();
    const pokemon = { dex: loadout.dex, shiny: !!loadout.shiny };
    const { ok, data } = await api('POST', '/api/runs/start', { pokemon });
    if (!ok) throw Object.assign(new Error('start failed'), { code: errorCode(data) });
    return data as { runId: string; startedAt: string };
  },
  async reportRun(runId: string, summary: RunSummary) {
    const { ok, data } = await api('POST', '/api/runs', { ...summary, runId });
    if (!ok) throw Object.assign(new Error('report failed'), { code: errorCode(data) });
    return data as Awaited<ReturnType<SoloApi['reportRun']>>;
  },
};

const errorCode = (data: unknown) =>
  (data as { error?: { code?: string } } | null)?.error?.code ?? 'error';

/** The loadout from the save, as the server builds co-op ones (apps/server/src/game/loadout.ts). */
async function loadSoloLoadout(): Promise<{
  loadout: PlayerConfig;
  owned: number[];
  username: string;
}> {
  const me = (await api('GET', '/api/auth/me')).data as { user: { id: string; username: string } };
  const save = (await api('GET', '/api/save')).data as {
    partner: { dex: number | null; shiny: boolean };
    owned: Record<string, unknown>;
    shiny: Record<string, unknown>;
    upgrades: Record<string, Record<string, number>>;
    moveBans: Record<string, string[]>;
    moveBindings: Record<string, (string | null)[]>;
    legendsBeaten: Record<string, unknown>;
  };
  const dex = save.partner.dex;
  if (dex === null) throw new Error('no partner chosen');
  const key = String(dex);
  return {
    username: me.user.username,
    owned: Object.keys(save.owned).map(Number),
    loadout: {
      id: me.user.id,
      dex,
      shiny: save.partner.shiny && save.shiny[key] !== undefined,
      upgrades: save.upgrades[key] ?? {},
      bannedMoves: save.moveBans[key] ?? [],
      moveBindings: save.moveBindings[key] ?? [],
      legendsBeaten: Object.keys(save.legendsBeaten).map(Number),
    },
  };
}

let handle: GameHandle | null = null;
let devKeys: ((code: string) => void) | null = null;
addEventListener('keydown', (e) => devKeys?.(e.code));

async function playSolo(): Promise<void> {
  panel.style.display = 'none';
  try {
    const opts = await loadSoloLoadout();
    const seed = Number(params.get('seed')) || undefined;
    // ?t=<minutes>: start late in a run (perf tests, late-game screenshots); not credited.
    const skipMinutes = Number(params.get('t')) || undefined;
    const offline: SoloApi = {
      startRun: () => Promise.reject(new Error('fast-forwarded runs are not reported')),
      reportRun: () => Promise.reject(new Error('not reported')),
    };
    // ?god: can't be hurt (perf tests); not credited either.
    const invulnerable = params.has('god');
    const conn = createSoloConnection({
      ...opts,
      seed,
      skipMinutes,
      invulnerable,
      api: skipMinutes || invulnerable ? offline : devApi,
    });
    // Dev triggers, as in /?debug-sim: F rift · V arena · H horde · J golden hour · K lost Pokémon
    // · T thief · B weather (runs with triggers aren't reported either).
    const keys: Record<string, Parameters<typeof conn.devTrigger>[0]> = {
      KeyF: 'rift',
      KeyV: 'arena',
      KeyH: 'horde',
      KeyJ: 'gold',
      KeyK: 'lost',
      KeyT: 'thief',
      KeyB: 'weather',
    };
    devKeys =
      skipMinutes || invulnerable ? (code) => keys[code] && conn.devTrigger(keys[code]) : null;
    handle = mountGame(root, conn, {
      onExit: (results) => {
        handle?.dispose();
        handle = null;
        panel.style.display = '';
        panel.innerHTML = `<b>run over</b> (${esc(results?.reason ?? 'left')}, credited: ${results?.credited ?? false})<br><br>
          <button id="again">play again</button>`;
        panel.querySelector('#again')!.addEventListener('click', () => void playSolo());
      },
    });
  } catch (err) {
    panel.style.display = '';
    panel.textContent = `could not start: ${String(err)}`;
  }
}

// ---------------------------------------------------------------- multiplayer

function playNet(): void {
  const client = new NetClient({ url: socketUrl(location) });
  let log: string[] = [];
  const say = (line: string) => {
    log = [line, ...log].slice(0, 6);
    render();
  };
  for (const ev of ['state', 'room', 'invite', 'presence', 'invite.revoked'] as const)
    client.on(ev, () => render());
  client.on('error', (e) => say(`error: ${e.code}`));
  client.on('loading', ({ room }) => mount(room));
  // Reconnected into a running game (e.g. after a reload).
  client.on('start', ({ room }) => {
    if (!handle) mount(room);
  });

  function mount(room: NetRoomConnection): void {
    if (handle) return;
    panel.style.display = 'none';
    handle = mountGame(root, room, {
      client,
      onLeave: () => client.leaveRoom(),
      onExit: (results) => {
        handle?.dispose();
        handle = null;
        panel.style.display = '';
        say(results ? `results: ${results.reason}, credited ${results.credited}` : 'left the game');
      },
    });
  }

  const act = (fn: () => Promise<unknown>) =>
    void fn().then(
      () => render(),
      (err: Error & { code?: string }) => say(`✗ ${err.code ?? err.message}`),
    );

  function render(): void {
    if (handle) return;
    const room = client.roomView;
    const me = client.user?.id;
    panel.innerHTML = `<b>${esc(client.user?.username ?? '…')}</b> — ${client.state}
      <hr><input id="friend" placeholder="friend's username" size="14"> <button id="add">add friend</button>
      <div id="incoming"></div>
      ${[...client.friends].map(([n, s]) => `<div>${esc(n)} <i>${s}</i> ${room && s !== 'offline' ? `<button data-invite="${esc(n)}">invite</button>` : ''}</div>`).join('')}
      ${[...client.invites.values()].map((i) => `<div>invite from ${esc(i.from)} <button data-join="${esc(i.roomId)}">join</button></div>`).join('')}
      <hr>${
        room
          ? `<b>room</b> (${room.phase})${room.members
              .map(
                (m) =>
                  `<div>${m.userId === room.ownerId ? '★' : '·'} ${esc(m.username)} — ${m.status}</div>`,
              )
              .join('')}
            ${room.blockers.length ? `<div style="color:#fc6">waiting for: ${room.blockers.map(esc).join(', ')}</div>` : ''}
            <button data-status="ready">ready</button> <button data-status="not-ready">not ready</button>
            ${room.ownerId === me ? '<button id="start">start</button>' : ''} <button id="leave">leave</button>`
          : '<button id="create">create room</button>'
      }<hr>${log.map(esc).join('<br>')}`;
    const on = (sel: string, fn: (el: HTMLElement) => void) =>
      panel
        .querySelectorAll<HTMLElement>(sel)
        .forEach((el) => el.addEventListener('click', () => fn(el)));
    on('#create', () => act(() => client.createRoom()));
    on('#start', () => act(() => client.start()));
    on('#leave', () => act(() => client.leaveRoom()));
    on('[data-invite]', (el) => act(() => client.invite(el.dataset.invite!)));
    on('[data-join]', (el) => act(() => client.join(el.dataset.join!)));
    on('[data-status]', (el) =>
      act(() => client.setStatus(el.dataset.status as 'ready' | 'not-ready')),
    );
    on('#add', () => {
      const name = panel.querySelector<HTMLInputElement>('#friend')!.value;
      void api('POST', '/api/friends/requests', { username: name }).then(({ ok, data }) =>
        say(ok ? 'friend request sent' : `✗ ${JSON.stringify(data)}`),
      );
    });
    void api('GET', '/api/friends').then(({ ok, data }) => {
      const box = panel.querySelector('#incoming');
      if (!ok || !box) return;
      for (const r of (data as { incoming: { username: string }[] }).incoming) {
        const b = document.createElement('button');
        b.textContent = `accept ${r.username}`;
        b.onclick = () =>
          void api('POST', `/api/friends/requests/${encodeURIComponent(r.username)}/accept`).then(
            () => render(),
          );
        box.append(b);
      }
    });
  }
  render();
}

void api('GET', '/api/auth/me').then(({ ok }) => {
  const go = () => (mode === 'net' ? playNet() : void playSolo());
  if (ok) go();
  else login(go);
});
