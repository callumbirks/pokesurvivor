// Dev-only sim viewer (/?debug-sim): runs @pokesurvivor/sim locally and draws its state with plain
// shapes, for eyeballing behaviour. Not the game renderer.
//   WASD / arrows  move player 1        1-4 / Q / E  switch move (or pick a card / item)
//   R reroll cards   G god mode   P peaceful (no spawns)   +/- sim speed   N new run
//   F open a rift   V arena now   H horde   J golden hour   K lost Pokémon   T thief   B weather
// URL params: players=1..4 (the others are simple bots), seed=, dex=, t=<minutes to skip ahead>.
import { t } from '@pokesurvivor/data';
import {
  createSim,
  drainTicks,
  liquidKind,
  propHp,
  propsInRect,
  terrainRaw,
  TICK_MS,
  TILE,
  VIEW_H,
  VIEW_W,
  WALL,
  LIQUID,
  type Sim,
} from '@pokesurvivor/sim';

const TYPE_COLORS: Record<string, string> = {
  normal: '#b0a99f',
  fire: '#ff7b3d',
  water: '#4b9bff',
  grass: '#5fcb6a',
  electric: '#ffd33d',
  ice: '#7fe0e0',
  fighting: '#e0533d',
  poison: '#b45ec4',
  ground: '#d6b25c',
  flying: '#9bb8ff',
  psychic: '#ff5f9e',
  bug: '#a3c43d',
  rock: '#bfa96b',
  ghost: '#7a6bc4',
  dragon: '#6b58ff',
  dark: '#6b5c52',
  steel: '#a8b8c4',
  fairy: '#ff9ed8',
};
const PLAYER_COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8'];
const PICKUP_COLORS: Record<string, string> = {
  xp: '#7fe0ff',
  'xp-big': '#ffd95e',
  coin: '#ffd23f',
  heal: '#5fe08a',
  magnet: '#ff9ed8',
  bomb: '#ff7b3d',
  ticket: '#ffd23f',
  ticket10: '#c47bff',
  gem: '#5fe3ff',
  item: '#ffffff',
};
const PROP_COLORS: Record<string, string> = {
  tree: '#1f5a25',
  rock: '#7f8893',
  chest: '#d9a520',
  grass: '#4c9a3f',
  altar: '#c47bff',
  spring: '#5fd4ff',
  'big-chest': '#f2c443',
  trap: '#a04040',
};

export function startDebugSim(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const params = new URLSearchParams(location.search);
  const count = Math.max(1, Math.min(4, Number(params.get('players')) || 1));
  const dex = Number(params.get('dex')) || 25;
  let sim = newRun(Number(params.get('seed')) || Math.floor(Math.random() * 1e6));
  const skip = Number(params.get('t')) || 0;
  if (skip > 0) while (sim.state.time < skip * 60) botTick(sim, true);

  const keys = new Set<string>();
  let speed = 1;
  let acc = 0;
  let last = performance.now();
  let stepMs = 0;
  const banners: { text: string; until: number }[] = [];
  /** Bond choice (pair): the first move picked. */
  let bondFirst: string | null = null;
  const WEATHERS = ['sun', 'rain', 'sand', 'snow', 'fog'] as const;
  let weatherIdx = 0;

  function newRun(seed: number): Sim {
    const players = Array.from({ length: count }, (_, i) => ({
      id: i ? `bot${i}` : 'you',
      dex: i ? [4, 7, 1][i - 1]! : dex,
    }));
    return createSim({ seed, players, choiceTimeoutSeconds: null });
  }

  addEventListener('keydown', (e) => {
    keys.add(e.code);
    const s = sim.state;
    const mine = s.pendingChoices.find((c) => c.playerId === 'you');
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (mine && digit) {
      const i = Number(digit[1]) - 1;
      if (mine.kind === 'level-up' && mine.options[i]) {
        sim.submitIntent('you', {
          type: 'pickCard',
          choiceId: mine.id,
          cardId: mine.options[i].id,
        });
      } else if (mine.kind === 'item' && i < 2) {
        sim.submitIntent('you', {
          type: 'pickItem',
          choiceId: mine.id,
          itemId: i ? mine.found : mine.held,
        });
      } else if (mine.kind === 'bond' && mine.loose[i]) {
        const m = mine.loose[i];
        if (mine.mode === 'pair' && !bondFirst) bondFirst = m;
        else if (m !== bondFirst) {
          const moves = mine.mode === 'pair' && bondFirst ? [bondFirst, m] : [m];
          sim.submitIntent('you', { type: 'pickBond', choiceId: mine.id, moves });
          bondFirst = null;
        }
      }
    } else if (digit) sim.setInput('you', { ...move(), slot: Number(digit[1]) - 1 });
    if (e.code === 'KeyR' && mine) sim.submitIntent('you', { type: 'reroll', choiceId: mine.id });
    if (e.code === 'KeyQ') sim.submitIntent('you', { type: 'cycleSlot', dir: -1 });
    if (e.code === 'KeyE') sim.submitIntent('you', { type: 'cycleSlot', dir: 1 });
    if (e.code === 'KeyG') s.config.invulnerable = !s.config.invulnerable;
    if (e.code === 'KeyP') s.config.noSpawns = !s.config.noSpawns;
    if (e.key === '+' || e.key === '=') speed = Math.min(8, speed * 2);
    if (e.key === '-') speed = Math.max(0.25, speed / 2);
    if (e.code === 'KeyN') sim = newRun(Math.floor(Math.random() * 1e6));
    if (e.code === 'KeyF') sim.debugOpenRift();
    if (e.code === 'KeyV') sim.debugStartArena();
    if (e.code === 'KeyH') sim.debugStartEvent('horde');
    if (e.code === 'KeyJ') sim.debugStartEvent('gold');
    if (e.code === 'KeyK') sim.debugStartEvent('lost');
    if (e.code === 'KeyT') sim.debugStartEvent('thief');
    if (e.code === 'KeyB') sim.debugStartWeather(WEATHERS[weatherIdx++ % WEATHERS.length]!, 30);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));

  function move() {
    const x =
      (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
      (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const y =
      (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) -
      (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
    return { moveX: x, moveY: y };
  }

  /** Bots: other players circle and take the first card; with `all`, player 1 too. */
  function botTick(s: Sim, all = false) {
    for (const c of s.state.pendingChoices.slice()) {
      if (c.playerId === 'you' && !all) continue;
      if (c.kind === 'level-up')
        s.submitIntent(c.playerId, {
          type: 'pickCard',
          choiceId: c.id,
          cardId: c.options[0]?.id ?? '',
        });
      else if (c.kind === 'item')
        s.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.held });
      else
        s.submitIntent(c.playerId, {
          type: 'pickBond',
          choiceId: c.id,
          moves: c.loose.slice(0, c.mode === 'add' ? 1 : 2),
        });
    }
    s.state.players.forEach((p, i) => {
      if (i === 0 && !all) return;
      const a = s.state.tick / 200 + i * 2;
      s.setInput(p.id, { moveX: Math.cos(a), moveY: Math.sin(a) });
    });
    if (all) s.state.config.invulnerable = true;
    s.step();
    if (all) s.state.config.invulnerable = false;
    s.drainEvents();
  }

  function frame(now: number) {
    acc += Math.min(250, now - last) * speed;
    last = now;
    const { ticks, remainderMs } = drainTicks(acc);
    acc = remainderMs;
    const t0 = performance.now();
    for (let i = 0; i < ticks; i++) {
      sim.setInput('you', move());
      botTick(sim);
    }
    if (ticks) stepMs = (performance.now() - t0) / ticks;
    for (const e of sim.drainEvents()) {
      if (e.type === 'say' && (!e.playerId || e.playerId === 'you')) {
        banners.push({ text: t(e.key, e.params), until: now + e.seconds * 1000 });
      }
    }
    draw(now);
    requestAnimationFrame(frame);
  }

  function draw(now: number) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const s = sim.state;
    const me = s.players[0];
    if (!me) return;
    const scale = Math.min(w / VIEW_W, h / VIEW_H);
    const vw = w / scale;
    const vh = h / scale;
    const left = me.x - vw / 2;
    const top = me.y - vh / 2;

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -left * dpr * scale, -top * dpr * scale);
    ctx.fillStyle = '#2f4f2f';
    ctx.fillRect(left, top, vw, vh);
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + vh) / TILE); ty++) {
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + vw) / TILE); tx++) {
        const tt = terrainRaw(s.world.seed, tx, ty, s.world.arena);
        if (tt === WALL) ctx.fillStyle = '#555c66';
        else if (tt === LIQUID)
          ctx.fillStyle = sim.ctx.d.liquidHurts(liquidKind(sim.ctx)) ? '#b9401a' : '#2c64a6';
        else continue;
        ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      }
    }
    const wd = s.world;
    for (const p of propsInRect(sim.ctx, left - 40, top - 40, left + vw + 40, top + vh + 40)) {
      ctx.globalAlpha = p.type === 'altar' && wd.altarsUsed[p.key] ? 0.3 : 1;
      circle(p.x, p.y, p.r, PROP_COLORS[p.type] ?? '#fff', p.type !== 'grass');
      ctx.globalAlpha = 1;
      if (p.destructible && propHp(sim.ctx, p) < p.maxHp)
        bar(p.x, p.y - p.r - 4, 20, propHp(sim.ctx, p) / p.maxHp, '#ccc');
      if (p.type === 'spring') bar(p.x, p.y - p.r - 4, 24, wd.springs[p.key] ?? 1, '#5fd4ff');
      if (p.type === 'big-chest' && wd.chests[p.key])
        bar(p.x, p.y - p.r - 4, 24, (wd.chests[p.key] ?? 0) / 3.5, '#f2c443');
      if (p.type === 'altar' || p.type === 'trap' || p.type === 'big-chest' || p.type === 'spring')
        label(p.type, p.x, p.y + p.r + 9, '#eee');
    }
    const rift = s.rift.open;
    if (rift) {
      circle(rift.x, rift.y - 10, 30, '#b48aff', false);
      circle(rift.x, rift.y - 10, 14, '#7b3cff', true);
      label(`RIFT ${Math.ceil(rift.ttl)}s`, rift.x, rift.y - 46, '#d9c2ff');
    }
    const lost = s.events.lost;
    if (lost) {
      circle(lost.tx, lost.ty, 56, '#7dffb0', false);
      label('marker', lost.tx, lost.ty, '#7dffb0');
      circle(lost.x, lost.y, lost.r, '#7dffb0', true);
      bar(lost.x, lost.y - lost.r - 6, 24, lost.hp / lost.maxHp, '#5fe08a');
      label(lost.phase === 'wait' ? '!' : 'lost', lost.x, lost.y + lost.r + 9, '#7dffb0');
    }
    for (const f of s.fields) {
      ctx.globalAlpha = f.kind === 'patch' ? 0.35 : 0.8;
      circle(
        f.x,
        f.y,
        f.kind === 'turret' ? 8 : f.kind === 'mine' ? 6 : f.r,
        TYPE_COLORS[f.type] ?? '#fff',
        f.kind !== 'meteor',
      );
      ctx.globalAlpha = 1;
    }
    for (const hz of s.hazards) {
      ctx.globalAlpha = hz.hit ? 0.6 : 0.25 + 0.4 * Math.min(1, hz.t / hz.delay);
      ctx.fillStyle = ctx.strokeStyle = TYPE_COLORS[hz.type] ?? '#f44';
      if (hz.kind === 'zone') circle(hz.x, hz.y, hz.r, ctx.fillStyle, hz.hit);
      else {
        ctx.save();
        ctx.translate(hz.x, hz.y);
        ctx.rotate(hz.angle);
        if (hz.hit) ctx.fillRect(0, -hz.w / 2, hz.len, hz.w);
        else ctx.strokeRect(0, -hz.w / 2, hz.len, hz.w);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    for (const p of s.pickups)
      circle(p.x, p.y, p.kind === 'item' ? 6 : 3, PICKUP_COLORS[p.kind] ?? '#fff', true);
    for (const e of s.enemies) {
      circle(
        e.x,
        e.y,
        e.r,
        e.shiny ? '#9ae6ff' : (TYPE_COLORS[e.types[0] ?? 'normal'] ?? '#f55'),
        true,
      );
      if (e.boss) circle(e.x, e.y, e.r + 3, e.ai?.fury ? '#ff4a4a' : '#ffd95e', false);
      if (e.legend) circle(e.x, e.y, e.r + 6, '#c9a6ff', false);
      if (e.golden || e.behavior === 'thief') circle(e.x, e.y, e.r + 2, '#ffd23f', false);
      if (e.shield > 0) circle(e.x, e.y, e.r + 5, '#9fd8ff', false);
      if (e.burn > 0 || e.poison > 0)
        circle(e.x, e.y, e.r * 0.5, e.burn ? '#ff8a3d' : '#c86bdc', true);
      if (e.hp < e.maxHp || e.boss)
        bar(e.x, e.y - e.r - 6, e.boss ? 60 : 24, e.hp / e.maxHp, e.boss ? '#ffcb3d' : '#ff5f6d');
      label(e.behavior === 'chase' ? '' : e.behavior, e.x, e.y + e.r + 9, '#ddd');
    }
    for (const q of s.projectiles)
      circle(
        q.x,
        q.y,
        q.r,
        q.friendly ? (TYPE_COLORS[q.type ?? 'normal'] ?? '#ff0') : '#ff3b6b',
        true,
      );
    s.players.forEach((p, i) => {
      if (p.left) return;
      ctx.globalAlpha = p.connected ? (p.invuln > 0 ? 0.6 : 1) : 0.35;
      circle(p.x, p.y, p.r, p.dead ? '#555' : (PLAYER_COLORS[i] ?? '#fff'), true);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(p.aim) * (p.r + 12), p.y + Math.sin(p.aim) * (p.r + 12));
      ctx.stroke();
      circle(p.x, p.y, p.magnet, 'rgba(255,255,255,0.15)', false);
      bar(p.x, p.y - p.r - 8, 30, p.hp / p.maxHp, '#5fe08a');
      if (p.dead) bar(p.x, p.y + p.r + 6, 30, p.reviveT / 3, '#ffd23f');
      label(p.id, p.x, p.y - p.r - 12, PLAYER_COLORS[i] ?? '#fff');
    });

    // HUD (screen space)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lines = [
      `t ${Math.floor(s.time / 60)}:${String(Math.floor(s.time % 60)).padStart(2, '0')}  tick ${s.tick}  ×${speed}  step ${stepMs.toFixed(2)} ms (budget ${TICK_MS.toFixed(1)})`,
      `level ${s.team.level}  xp ${Math.floor(s.team.xp)}/${s.team.xpNext}  kills ${s.team.kills}  bosses ${s.team.bosses}  coins ${s.team.coins}  tickets ${s.team.tickets}/${s.team.tickets10}  gems ${s.team.gems}`,
      `enemies ${s.enemies.length}  projectiles ${s.projectiles.length}  pickups ${s.pickups.length}  fields ${s.fields.length}  hazards ${s.hazards.length}  biome ${s.world.biome}`,
      `HP ${Math.ceil(me.hp)}/${Math.round(me.maxHp)}  item ${me.item ?? '-'}  power ${me.power ? `${me.power.id} ${Math.ceil(me.power.t)}s` : '-'}  bonds ${me.bonds}  ${s.config.invulnerable ? 'GOD ' : ''}${s.config.noSpawns ? 'PEACEFUL' : ''}`,
      `rift ${s.rift.open ? `open ${Math.ceil(s.rift.open.ttl)}s` : `next roll ${Math.ceil(s.rift.checkT)}s (misses ${s.rift.misses})`}  opened ${s.rift.opened}` +
        (s.arena
          ? `  ARENA ${s.arena.type} vs #${s.arena.dex}${s.arena.shiny ? ' shiny' : ''} ${s.arena.phase} ${Math.max(0, Math.ceil(sim.ctx.d.game.tuning.rift.arenaTime - s.arena.t))}s`
          : ''),
      `weather ${s.weather.current ? `${s.weather.current.kind} ${Math.ceil(s.weather.current.dur - s.weather.current.t)}s` : '-'}  event ${s.events.current ? `${s.events.current.id}${s.events.current.type ? ' ' + s.events.current.type : ''}${s.events.current.dur !== null ? ' ' + Math.ceil(s.events.current.dur - s.events.current.t) + 's' : ''}` : `- (next ${Math.ceil(s.events.nextT)}s)`}  thieves ${s.events.thieves}`,
      'moves: ' +
        me.slots
          .map(
            (slot, i) =>
              `${i === me.active ? '>' : ' '}${i + 1} ${slot
                .map((id) => {
                  const m = me.moves.find((x) => x.id === id);
                  return `${id} L${m?.level ?? 0}${m?.evolved ? '*' : ''}`;
                })
                .join('+')}`,
          )
          .join('   '),
    ];
    const mine = s.pendingChoices.find((c) => c.playerId === 'you');
    if (mine?.kind === 'level-up') {
      lines.push(`LEVEL ${mine.level}! pick 1-${mine.options.length} (R reroll):`);
      mine.options.forEach((o, i) =>
        lines.push(
          `  ${i + 1}. ${o.type} ${o.moveId ?? o.statId ?? ''}${o.toLevel ? ' → L' + o.toLevel : ''}${o.unlocksEvolutionOf ? ' (evolves ' + o.unlocksEvolutionOf + ')' : ''}`,
        ),
      );
    } else if (mine?.kind === 'item') {
      lines.push(`ITEM: 1 keep ${mine.held}   2 switch to ${mine.found}`);
    } else if (mine?.kind === 'bond') {
      lines.push(
        mine.mode === 'add'
          ? `BOND: pick the move that joins ${mine.group?.join('+') ?? ''}`
          : bondFirst
            ? `BOND: bond ${bondFirst} with…`
            : 'BOND: pick the first move to bond',
      );
      mine.loose.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
    } else if (s.pendingChoices.length) {
      lines.push(
        `paused: waiting for ${[...new Set(s.pendingChoices.map((c) => c.playerId))].join(', ')}`,
      );
    }
    if (s.ended) lines.push(`RUN OVER (${s.ended.reason}) — N for a new run`);
    ctx.font = '13px ui-monospace, monospace';
    lines.forEach((l, i) => {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(6, 6 + i * 17, ctx.measureText(l).width + 8, 17);
      ctx.fillStyle = '#eee';
      ctx.fillText(l, 10, 19 + i * 17);
    });
    const live = banners.filter((b) => b.until > now);
    banners.length = 0;
    banners.push(...live);
    ctx.textAlign = 'center';
    ctx.font = '18px system-ui, sans-serif';
    live.slice(-3).forEach((b, i) => {
      ctx.fillStyle = '#fff';
      ctx.fillText(b.text, w / 2, h * 0.25 + i * 24);
    });
    ctx.textAlign = 'left';
    ctx.fillStyle = '#aaa';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(
      'WASD move · 1-4/Q/E moves or choices · R reroll · G god · P peaceful · +/- speed · N new run · F rift · V arena · H/J/K/T events · B weather',
      10,
      h - 10,
    );
  }

  function circle(x: number, y: number, r: number, color: string, fill: boolean) {
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

  function bar(x: number, y: number, w: number, k: number, color: string) {
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x - w / 2, y, w, 3);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, k)), 3);
  }

  function label(text: string, x: number, y: number, color: string) {
    if (!text) return;
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
  }

  requestAnimationFrame(frame);
}
