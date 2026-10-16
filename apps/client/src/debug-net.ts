// Dev-only network view (/?debug-net): logs in, makes friends, creates or joins a room and plays
// over the WebSocket, drawing the snapshots with plain shapes (like /?debug-sim). Not the game UI.
//   WASD / arrows  move      1-4  switch move, or pick a card / option      Q / E  cycle moves
//   R  reroll cards          B  toggle busy (as if in the gacha)
// Two accounts in one browser share the session cookie: use a private window for the second,
// or open the other tab on 127.0.0.1 instead of localhost (cookies are per host).
import {
  NetClient,
  firstOption,
  interpolate,
  socketUrl,
  type NetRoomConnection,
  type Results,
} from '@pokesurvivor/netclient';
import type { MemberStatus } from '@pokesurvivor/protocol';
import {
  LIQUID,
  TILE,
  VIEW_H,
  VIEW_W,
  WALL,
  createSim,
  propsInRect,
  terrainRaw,
} from '@pokesurvivor/sim';
import type { Intent, PendingChoice, Sim } from '@pokesurvivor/sim';

const PLAYER_COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8'];
const PICKUP_COLORS: Record<string, string> = {
  xp: '#7fe0ff',
  'xp-big': '#ffd95e',
  coin: '#ffd23f',
  heal: '#5fe08a',
  ticket: '#ffd23f',
  ticket10: '#c47bff',
  gem: '#5fe3ff',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(
  method: string,
  url: string,
  body?: object,
): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, data };
}

export function startDebugNet(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:8px;right:8px;width:320px;max-height:95vh;overflow:auto;background:rgba(0,0,0,.8);' +
    'color:#eee;font:13px ui-monospace,monospace;padding:10px;border-radius:6px;z-index:2';
  document.body.append(panel);

  let client: NetClient | null = null;
  let log: string[] = [];
  let results: Results | null = null;
  let world: Sim | null = null;
  let stopInput: (() => void) | null = null;
  const keys = new Set<string>();
  const say = (line: string) => {
    log = [line, ...log].slice(0, 8);
    render();
  };

  // ---------------------------------------------------------------- login

  void api('GET', '/api/auth/me').then(({ ok }) => (ok ? connect() : renderLogin()));

  function renderLogin(): void {
    panel.innerHTML = `<b>debug-net: log in</b><br><br>
      <input id="u" placeholder="username" style="width:95%"><br>
      <input id="p" placeholder="password (8+)" type="password" style="width:95%"><br><br>
      <button id="login">log in</button> <button id="register">register (+ Charmander)</button>
      <p id="err" style="color:#f88"></p>`;
    const value = (id: string) => (panel.querySelector(`#${id}`) as HTMLInputElement).value;
    const go = async (path: string) => {
      const { ok, data } = await api('POST', `/api/auth/${path}`, {
        username: value('u'),
        password: value('p'),
      });
      if (!ok) {
        panel.querySelector('#err')!.textContent = JSON.stringify(data);
        return;
      }
      // New accounts need a partner to play: take Charmander as the starter.
      if (path === 'register') await api('POST', '/api/save/starter', { dex: 4 });
      connect();
    };
    panel.querySelector('#login')!.addEventListener('click', () => void go('login'));
    panel.querySelector('#register')!.addEventListener('click', () => void go('register'));
  }

  // ---------------------------------------------------------------- lobby

  function connect(): void {
    client = new NetClient({ url: socketUrl(location), autoLoad: true });
    for (const event of ['state', 'room', 'invite', 'presence', 'invite.revoked'] as const)
      client.on(event, () => render());
    client.on('notice', (n) => say(`notice: ${n.code} ${n.usernames?.join(', ') ?? ''}`));
    client.on('friend', (f) => say(`friend: ${f.event} ${f.username}`));
    client.on('invite.declined', (d) => say(`${d.username} declined`));
    client.on('error', (e) => say(`error: ${e.code}`));
    client.on('start', ({ room, game }) => {
      results = null;
      world = createSim({
        seed: game.seed,
        players: game.players.map((p) => ({ id: p.id, dex: p.dex })),
      });
      startInput(room);
      say(`game ${game.gameId.slice(0, 8)} started`);
    });
    client.on('results', (r) => {
      results = r;
      stopInput?.();
      say(`results: ${r.reason}, credited ${r.credited}`);
    });
    requestAnimationFrame(frame);
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      say(`✗ ${(err as { code?: string }).code ?? String(err)}`);
    }
    render();
  }

  function render(): void {
    if (!client) return;
    const c = client;
    const room = c.roomView;
    const me = c.user?.id;
    const friends = [...c.friends].map(
      ([name, status]) =>
        `<div>${esc(name)} <i>${status}</i> ${
          room && status !== 'offline' && !room.members.some((m) => m.username === name)
            ? `<button data-invite="${esc(name)}">invite</button>`
            : ''
        }</div>`,
    );
    const invites = [...c.invites.values()].map(
      (i) =>
        `<div>invite from ${esc(i.from)} <button data-join="${esc(i.roomId)}">join</button>
         <button data-decline="${esc(i.roomId)}">decline</button></div>`,
    );
    const members =
      room?.members.map(
        (m) =>
          `<div>${m.userId === room.ownerId ? '★' : '·'} ${esc(m.username)} — ${m.status}${
            m.connected ? '' : ' (offline)'
          }${m.inGame ? ' [in game]' : ''}${m.partner ? ` #${m.partner.dex}` : ' (no partner)'}${
            room.ownerId === me && m.userId !== me
              ? ` <button data-kick="${esc(m.userId)}">kick</button>`
              : ''
          }</div>`,
      ) ?? [];
    const statusButtons = (['ready', 'not-ready', 'busy'] as MemberStatus[])
      .map((s) => `<button data-status="${s}">${s}</button>`)
      .join(' ');
    panel.innerHTML = `<b>${esc(c.user?.username ?? '…')}</b> — ${c.state}${c.draining ? ' (server updating)' : ''}
      <hr><b>friends</b> <input id="friend" placeholder="username" size="10"> <button id="add">add</button>
      ${friends.join('') || '<div>none</div>'}
      <div id="incoming"></div>
      ${invites.length ? `<hr><b>invites</b>${invites.join('')}` : ''}
      <hr>${
        room
          ? `<b>room ${esc(room.id)}</b> (${room.phase})${members.join('')}
             ${room.blockers.length ? `<div style="color:#fc6">waiting for: ${room.blockers.map(esc).join(', ')}</div>` : ''}
             <div>${statusButtons}</div>
             <div>${room.ownerId === me && room.phase === 'lobby' ? '<button id="start">start</button> ' : ''}<button id="leave">leave</button></div>`
          : '<button id="create">create room</button>'
      }
      ${
        results
          ? `<hr><b>results</b> (${esc(results.reason)}, credited ${results.credited})${results.players
              .map(
                (p) =>
                  `<div>${esc(p.username)}${p.left ? ' (left)' : ''}: ${p.summary.run.coins} coins, ${p.summary.run.durationS}s</div>`,
              )
              .join('')}`
          : ''
      }
      <hr>${log.map(esc).join('<br>')}`;
    const on = (sel: string, fn: (el: HTMLElement) => void) =>
      panel
        .querySelectorAll<HTMLElement>(sel)
        .forEach((el) => el.addEventListener('click', () => fn(el)));
    on('#create', () => void act(() => c.createRoom()));
    on('#start', () => void act(() => c.start()));
    on('#leave', () => void act(() => c.leaveRoom()));
    on('[data-invite]', (el) => void act(() => c.invite(el.dataset.invite!)));
    on('[data-join]', (el) => void act(() => c.join(el.dataset.join!)));
    on('[data-decline]', (el) => void act(() => c.declineInvite(el.dataset.decline!)));
    on('[data-kick]', (el) => void act(() => c.kick(el.dataset.kick!)));
    on('[data-status]', (el) => void act(() => c.setStatus(el.dataset.status as MemberStatus)));
    on('#add', () => {
      const name = (panel.querySelector('#friend') as HTMLInputElement).value;
      void api('POST', '/api/friends/requests', { username: name }).then(({ ok, data }) =>
        say(ok ? `friend request: ${JSON.stringify(data)}` : `✗ ${JSON.stringify(data)}`),
      );
    });
    void api('GET', '/api/friends').then(({ ok, data }) => {
      const box = panel.querySelector('#incoming');
      if (!ok || !box || box.childElementCount) return;
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

  // ---------------------------------------------------------------- input

  function startInput(room: NetRoomConnection): void {
    stopInput?.();
    stopInput = room.startInputLoop(() => {
      const x =
        +(keys.has('KeyD') || keys.has('ArrowRight')) -
        +(keys.has('KeyA') || keys.has('ArrowLeft'));
      const y =
        +(keys.has('KeyS') || keys.has('ArrowDown')) - +(keys.has('KeyW') || keys.has('ArrowUp'));
      return { moveX: x, moveY: y };
    });
  }

  function choiceIntent(c: PendingChoice, i: number): Intent | null {
    if (c.kind === 'level-up') {
      const card = c.options[i];
      return card ? { type: 'pickCard', choiceId: c.id, cardId: card.id } : null;
    }
    if (c.kind === 'item')
      return i < 2 ? { type: 'pickItem', choiceId: c.id, itemId: i ? c.found : c.held } : null;
    return i === 0 ? firstOption(c) : null;
  }

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    keys.add(e.code);
    const room = client?.room;
    if (!room || room.phase !== 'running') {
      if (e.code === 'KeyB' && client?.roomView)
        void act(() =>
          client!.setStatus(
            client!.roomView!.members.find((m) => m.userId === client!.user?.id)?.status === 'busy'
              ? 'not-ready'
              : 'busy',
          ),
        );
      return;
    }
    const mine = room.latest?.choices[0];
    const digit = /^Digit([1-4])$/.exec(e.code);
    const send = (intent: Intent | null) => {
      if (intent) void room.intent(intent).then((r) => !r.ok && say(`✗ ${r.error}`));
    };
    if (digit && mine) send(choiceIntent(mine, Number(digit[1]) - 1));
    else if (digit) room.sendInput({ moveX: 0, moveY: 0, slot: Number(digit[1]) - 1 });
    if (e.code === 'KeyR' && mine) send({ type: 'reroll', choiceId: mine.id });
    if (e.code === 'KeyQ') send({ type: 'cycleSlot', dir: -1 });
    if (e.code === 'KeyE') send({ type: 'cycleSlot', dir: 1 });
  });
  addEventListener('keyup', (e) => keys.delete(e.code));

  // ---------------------------------------------------------------- drawing

  function frame(now: number): void {
    draw(now);
    requestAnimationFrame(frame);
  }

  function draw(now: number): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    const room = client?.room;
    const sample = room?.buffer.sample(now);
    const game = room?.game;
    if (!client || !room || !sample || !game || room.phase === 'loading') {
      text(
        [
          `debug-net — ${client?.state ?? 'log in'}`,
          client?.roomView ? `room ${client.roomView.phase}` : '',
        ],
        10,
      );
      return;
    }
    const view = interpolate(sample);
    const snap = view.snapshot;
    const me = view.players.find((p) => p.id === client!.user?.id) ?? view.players[0];
    if (!me) return;
    const scale = Math.min(w / VIEW_W, h / VIEW_H);
    const vw = w / scale;
    const vh = h / scale;
    const left = me.x - vw / 2;
    const top = me.y - vh / 2;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -left * dpr * scale, -top * dpr * scale);
    ctx.fillStyle = '#2f4f2f';
    ctx.fillRect(left, top, vw, vh);
    const arena = snap.misc.arena;
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + vh) / TILE); ty++) {
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + vw) / TILE); tx++) {
        const tt = terrainRaw(game.seed, tx, ty, arena);
        if (tt === WALL) ctx.fillStyle = '#555c66';
        else if (tt === LIQUID) ctx.fillStyle = '#2c64a6';
        else continue;
        ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
    }
    if (world) {
      // Props are a pure function of the seed and the broken ones: a local sim answers that.
      world.state.world.broken = (snap.world.broken ?? {}) as Record<string, 1>;
      world.state.world.arena = arena;
      for (const p of propsInRect(world.ctx, left - 40, top - 40, left + vw + 40, top + vh + 40))
        circle(p.x, p.y, p.r, p.type === 'tree' ? '#1f5a25' : '#7f8893', p.type !== 'grass');
    }
    if (snap.misc.rift) circle(snap.misc.rift.x, snap.misc.rift.y, 22, '#c47bff', false);
    for (const hz of snap.hazards) {
      ctx.globalAlpha = 0.2 + 0.5 * hz.progress;
      circle(hz.x, hz.y, hz.kind === 'zone' ? hz.r : 6, '#ff4a6a', hz.hit);
      ctx.globalAlpha = 1;
    }
    for (const f of snap.fields) circle(f.x, f.y, Math.min(f.r, 30), '#ffaa44', false);
    for (const p of snap.pickups)
      circle(p.x, p.y, p.kind === 'item' ? 6 : 3, PICKUP_COLORS[p.kind] ?? '#fff', true);
    for (const e of view.enemies) {
      circle(e.x, e.y, e.r, e.shiny ? '#9ae6ff' : e.boss ? '#ff7b3d' : '#d05050', true);
      if (e.hp < e.maxHp || e.boss)
        bar(e.x, e.y - e.r - 6, e.boss ? 60 : 24, e.hp / e.maxHp, '#ff5f6d');
    }
    for (const q of view.projectiles)
      circle(q.x, q.y, q.r, q.friendly ? '#ffee66' : '#ff3b6b', true);
    for (const p of view.players) {
      if (p.left) continue;
      ctx.globalAlpha = p.connected ? 1 : 0.35;
      circle(p.x, p.y, 12, p.dead ? '#555' : (PLAYER_COLORS[p.index] ?? '#fff'), true);
      ctx.globalAlpha = 1;
      bar(p.x, p.y - 20, 30, p.hp / Math.max(1, p.maxHp), '#5fe08a');
      const name = game.players.find((x) => x.id === p.id)?.username ?? p.id;
      ctx.font = '8px ui-monospace, monospace';
      ctx.fillStyle = PLAYER_COLORS[p.index] ?? '#fff';
      ctx.fillText(name, p.x - 14, p.y - 24);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const stats = client.stats();
    const t = snap.team;
    const lines = [
      `RTT ${stats.rttMs?.toFixed(0) ?? '—'} ms   snapshots ${stats.snapshotsPerSecond.toFixed(1)}/s   ${(stats.bytesPerSecond / 1024).toFixed(1)} KB/s   ack ${room.ackedInputSeq} (unacked ${room.unackedInputs().length})`,
      `tick ${snap.tick}  time ${snap.time.toFixed(0)} s  level ${t.level}  xp ${t.xp}/${t.xpNext}  kills ${t.kills}  enemies ${snap.enemies.length}`,
      `${snap.misc.weather ? `weather ${snap.misc.weather.kind}  ` : ''}${snap.misc.event ? `event ${snap.misc.event.id}  ` : ''}${arena ? `ARENA #${arena.dex} ${arena.phase}` : ''}`,
    ];
    if (snap.waiting.length)
      lines.push(
        `PAUSED — waiting for ${snap.waiting
          .map(
            (c) =>
              `${game.players.find((p) => p.id === c.playerId)?.username ?? c.playerId} (${c.kind}, ${c.deadlineTick === null ? '∞' : Math.max(0, Math.ceil((c.deadlineTick - snap.tick) / game.tickHz))} s)`,
          )
          .join(', ')}`,
      );
    const mine = snap.choices[0];
    if (mine?.kind === 'level-up')
      mine.options.forEach((o, i) =>
        lines.push(
          `  ${i + 1}. ${o.type} ${o.moveId ?? o.statId ?? ''}${o.toLevel ? ` → L${o.toLevel}` : ''}`,
        ),
      );
    else if (mine?.kind === 'item') lines.push(`  1. keep ${mine.held}   2. take ${mine.found}`);
    else if (mine) lines.push(`  1. ${mine.kind}: first option`);
    if (snap.ended) lines.push(`RUN OVER (${snap.ended.reason})`);
    text(lines, 10);
  }

  function text(lines: string[], y: number): void {
    ctx.font = '13px ui-monospace, monospace';
    lines.forEach((l, i) => {
      if (!l) return;
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(6, y + i * 17 - 4, ctx.measureText(l).width + 8, 17);
      ctx.fillStyle = '#eee';
      ctx.fillText(l, 10, y + 9 + i * 17);
    });
  }

  function circle(x: number, y: number, r: number, color: string, fill: boolean): void {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  function bar(x: number, y: number, w: number, k: number, color: string): void {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x - w / 2, y, w, 3);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, k)), 3);
  }
}
