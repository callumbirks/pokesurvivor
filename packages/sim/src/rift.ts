// Rifts and the legendary's arena (legacy systems/rift.js).
//
// A few times per run a rift opens near a player and waits `ttl` seconds. Touching it takes the
// whole team to a walled arena carved into a far corner of the map, against a legendary:
//   win   it drops tickets (a ×10 with `legendaryTicket10Chance`) and coins, everyone gets a
//         bond (fuse moves: see bonds.ts), and a few seconds later the team is back where it was
//   lose  (everyone down, or the time limit) back with no reward, the downed revived; the run goes on
// Meanwhile the map's enemies are put away (`arena.stash`) and nothing spawns; on return everything
// is as it was.
//
// The schedule. From `startAfter`, a roll every `checkEvery` s opens a rift with chance
// `chance × (1 + misses)` (20 %, 40 %, … 100 %), so there are at most 5 rolls (150 s) between the
// end of one rift (expired or arena over) and the next. Legacy broke that guarantee ("0 rifts in 9+
// minutes"): it skipped the roll entirely while any boss was alive, which in late game is nearly
// always, and its placement could fail silently after 24 tries with `misses` already reset. Here:
//   - a living boss doesn't affect the schedule: the rift opens anyway (the boss is stashed with
//     the rest of the map if the team goes in, and is back afterwards). Deferring until the boss
//     died would keep the bug wherever bosses live long.
//   - placement can't fail: the legacy ring, then a wider ring, then the free tile closest to the
//     ring, then the player's own spot; `misses` resets only once the rift is open.
import { bondOptions } from './bonds.js';
import { DT, TILE } from './constants.js';
import { activePlayers, emit, presentPlayers, type Ctx } from './ctx.js';
import { addEnemy, createEnemy, makeShiny, pokemonName, rebuildGrid } from './enemies.js';
import { TAU, clamp, dist2 } from './math.js';
import { resetPaths } from './pathing.js';
import { revivePlayer } from './players.js';
import { scaleHp } from './spawner.js';
import { clearWeather, startWeather } from './weather.js';
import { arenaTheme, isFree, resetChunks } from './world.js';
import type { EnemyDef, PlayerState } from './state.js';
import type { PokemonType } from '@pokesurvivor/data';

/** Touch the rift within this distance (of a point just above its base). */
const ENTER_RANGE = 30;
/** Arena centres are this many tiles out, far from anywhere the team walks. */
const ARENA_FROM = 5000;
const ARENA_SPREAD = 3000;
/** The fight is lost once everyone has been down this long. */
const ARENA_DOWN = 1.4;
/** Types whose legendaries shoot (the rest charge). */
const RANGED_TYPES: readonly PokemonType[] = [
  'psychic',
  'electric',
  'ghost',
  'fairy',
  'fire',
  'water',
  'ice',
  'dragon',
];

export const inArena = (ctx: Ctx): boolean => ctx.s.arena !== null;

/** The win/lose banner is up and the team is about to go back (Life Orb pauses, etc.). */
export const arenaEnding = (ctx: Ctx): boolean => !!ctx.s.arena && ctx.s.arena.phase !== 'fight';

/** Seconds left to beat the legendary (0 outside the arena). */
export function arenaTimeLeft(ctx: Ctx): number {
  const a = ctx.s.arena;
  return a ? Math.max(0, ctx.d.game.tuning.rift.arenaTime - a.t) : 0;
}

// ---------------------------------------------------------------- the rift on the map

export function updateRift(ctx: Ctx): void {
  const { s, d } = ctx;
  const R = d.game.tuning.rift;
  const rf = s.rift;
  if (s.arena) {
    arenaTick(ctx);
    return;
  }
  const open = rf.open;
  if (open) {
    open.t += DT;
    open.ttl -= DT;
    if (open.ttl <= 0) {
      rf.open = null;
      emit(ctx, { type: 'rift-closed', reason: 'expired' });
      return;
    }
    const by = activePlayers(s).find(
      (p) => !p.dead && dist2(p.x, p.y, open.x, open.y - 10) < ENTER_RANGE * ENTER_RANGE,
    );
    if (by) startArena(ctx);
    return;
  }
  if (s.time <= R.startAfter || !activePlayers(s).length) return;
  rf.checkT -= DT;
  if (rf.checkT > 0) return;
  rf.checkT = R.checkEvery;
  // No boss check: see the header.
  if (ctx.rand() < R.chance * (1 + rf.misses)) openRift(ctx);
  else rf.misses++;
}

function livingAnchor(ctx: Ctx): PlayerState | undefined {
  const players = activePlayers(ctx.s);
  const alive = players.filter((p) => !p.dead);
  return alive.length ? ctx.rand.pick(alive) : (players[0] ?? presentPlayers(ctx.s)[0]);
}

/** Opens a rift near a random living player (also for tests and the debug view). */
export function openRift(ctx: Ctx): void {
  const { s } = ctx;
  const near = livingAnchor(ctx);
  if (!near) return;
  const [x, y] = placeRift(ctx, near);
  const ttl = ctx.d.game.tuning.rift.ttl;
  s.rift.open = { x, y, ttl, t: 0 };
  s.rift.misses = 0;
  s.rift.opened++;
  emit(ctx, { type: 'rift-opened', x, y, ttl });
  emit(ctx, { type: 'say', key: 'hud.aMysteriousRiftHasOpened', seconds: 3 });
}

const RIFT_ROOM = 22;

/** Where a rift opens around `p`. Never fails (see the header). */
export function placeRift(ctx: Ctx, p: PlayerState): [number, number] {
  const { rand } = ctx;
  const [near, far] = ctx.d.game.tuning.rift.distance;
  const ring = (lo: number, hi: number, tries: number): [number, number] | null => {
    for (let i = 0; i < tries; i++) {
      const a = rand() * TAU;
      const r = rand.range(lo, hi);
      const x = p.x + Math.cos(a) * r;
      const y = p.y + Math.sin(a) * r * 0.85;
      if (isFree(ctx, x, y, RIFT_ROOM)) return [x, y];
    }
    return null;
  };
  const pt = ring(near, far, 24) ?? ring(near * 0.5, far * 1.6, 24);
  if (pt) return pt;
  // The free tile whose distance is closest to the ring.
  const span = Math.ceil((far * 1.6) / TILE);
  const ptx = Math.floor(p.x / TILE);
  const pty = Math.floor(p.y / TILE);
  let best: [number, number] | null = null;
  let bestK = Infinity;
  for (let j = -span; j <= span; j++) {
    for (let i = -span; i <= span; i++) {
      const x = (ptx + i + 0.5) * TILE;
      const y = (pty + j + 0.5) * TILE;
      const k = Math.abs(Math.hypot(x - p.x, y - p.y) - near);
      if (k >= bestK || !isFree(ctx, x, y, RIFT_ROOM)) continue;
      bestK = k;
      best = [x, y];
    }
  }
  return best ?? [p.x, p.y];
}

// ---------------------------------------------------------------- the arena

/** Rolls the legendary and takes the team into its arena. `type`: force the arena type. */
export function startArena(ctx: Ctx, type?: PokemonType): void {
  const { s, d, rand } = ctx;
  if (s.arena) return;
  const R = d.game.tuning.rift;
  let pool = d.game.pokedex.filter((p) => p.legendary && d.hasSprite(p.dex));
  if (type && pool.some((p) => p.types.includes(type)))
    pool = pool.filter((p) => p.types.includes(type));
  // Legendaries the players haven't beaten yet come up more often.
  const players = presentPlayers(s);
  const weights = pool.map((p) => {
    const fresh = players.filter((pl) => !pl.legendsBeaten.includes(p.dex)).length;
    return 1 + (R.unbeatenWeight - 1) * (players.length ? fresh / players.length : 1);
  });
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  let mi = 0;
  while (mi < pool.length - 1 && (r -= weights[mi] ?? 0) > 0) mi++;
  const mon = pool[mi];
  if (!mon) return;
  const tx = ARENA_FROM + Math.floor(rand() * ARENA_SPREAD);
  const ty = ARENA_FROM + Math.floor(rand() * ARENA_SPREAD);
  const shiny = d.body(mon.dex).shiny && rand() < R.shinyChance;
  // The arena of one of its types, at random.
  const arenaType = type ?? rand.pick(mon.types);
  const theme = arenaTheme(d, arenaType);
  const geometry = {
    tx,
    ty,
    r: R.arenaRadius,
    type: arenaType,
    pillars: theme.pillars,
    pools: theme.pools,
  };
  const x = tx * TILE + TILE / 2;
  const y = ty * TILE + TILE / 2;

  s.arena = {
    ...geometry,
    dex: mon.dex,
    shiny,
    x,
    y,
    back: Object.fromEntries(players.map((p) => [p.id, { x: p.x, y: p.y }])),
    t: 0,
    phase: 'fight',
    endT: 0,
    bossId: 0,
    downT: 0,
    stash: s.enemies.filter((e) => !e.dead),
  };
  s.enemies = [];
  rebuildGrid(ctx);
  s.projectiles = [];
  s.fields = [];
  s.hazards = [];
  s.world.arena = geometry;
  resetChunks(ctx);
  resetPaths(ctx);
  if (s.rift.open) {
    s.rift.open = null;
    emit(ctx, { type: 'rift-closed', reason: 'entered' });
  }
  // Each arena brings its weather (the volcano sun, the glacier snow…).
  if (theme.weather) startWeather(ctx, theme.weather, R.arenaTime + 15);
  // Everyone in a row in the south of the arena; the legendary waits in the north.
  players.forEach((p, i) => {
    teleport(p, x + (i - (players.length - 1) / 2) * 34, y + TILE * 3);
  });
  emit(ctx, {
    type: 'arena-entered',
    dex: mon.dex,
    shiny,
    arenaType,
    x,
    y,
    seconds: R.arenaTime,
  });
  emit(ctx, { type: 'say', key: 'hud.youEnteredTheRift', seconds: 2.4 });
  spawnLegend(ctx);
}

function teleport(p: PlayerState, x: number, y: number): void {
  p.x = p.prevX = x;
  p.y = p.prevY = y;
  p.vx = p.vy = 0;
  p.smoothVx = p.smoothVy = 0;
}

function spawnLegend(ctx: Ctx): void {
  const { s, d } = ctx;
  const a = s.arena;
  const mon = a && d.game.pokemonByDex.get(a.dex);
  if (!a || !mon) return;
  const t = s.time;
  const n = Math.max(1, activePlayers(s).length);
  const lk = d.late(t);
  const def: EnemyDef = {
    dex: mon.dex,
    behavior: mon.types.some((x) => RANGED_TYPES.includes(x)) ? 'ranged' : 'charger',
    hp: Math.round((3200 + t * 9) * lk * scaleHp(n) * (n > 1 ? 1.4 : 1)),
    speed: Math.round(clamp(48 + (mon.speed - 78) * 0.6, 48, 105)),
    damage: Math.round((36 + t / 20) * Math.pow(lk, 0.7)),
    xp: Math.round(500 + t * 1.2),
    shotDamage: Math.round((18 + t / 40) * Math.pow(lk, 0.7)),
    shotCooldown: 0.9,
    range: 300,
  };
  const e = createEnemy(ctx, def, a.x, a.y - TILE * 3.5, { hp: 1, speed: 1, damage: 1 }, true);
  e.legend = true;
  // It bumps into walls and pillars like you: flying over the rocks, your shots couldn't reach it.
  e.flying = false;
  if (a.shiny) makeShiny(e);
  addEnemy(ctx, e);
  a.bossId = e.id;
  emit(ctx, {
    type: 'say',
    key: e.shiny ? 'hud.aShinyWasWaitingIn' : 'hud.wasWaitingInTheRift',
    params: { 0: pokemonName(ctx, e.dex) },
    seconds: 3.2,
  });
}

/** Nobody leaves the arena's circle (in case something pushes too hard). */
function keepInside(ctx: Ctx): void {
  const a = ctx.s.arena;
  if (!a) return;
  const max = (a.r - 1.4) * TILE;
  for (const e of ctx.s.enemies) {
    const dx = e.x - a.x;
    const dy = e.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d > max) {
      e.x = a.x + (dx / d) * max;
      e.y = a.y + (dy / d) * max;
    }
  }
}

function arenaTick(ctx: Ctx): void {
  const { s, d } = ctx;
  const a = s.arena;
  if (!a) return;
  a.t += DT;
  if (a.phase === 'fight') {
    keepInside(ctx);
    const boss = ctx.enemyById.get(a.bossId);
    if (!boss || boss.dead) {
      won(ctx);
      return;
    }
    const players = presentPlayers(s);
    const allDown = players.length > 0 && players.every((p) => p.dead);
    a.downT = allDown ? a.downT + DT : 0;
    if (a.downT > ARENA_DOWN || a.t > d.game.tuning.rift.arenaTime) lost(ctx);
    return;
  }
  a.endT -= DT;
  if (a.endT <= 0) finishArena(ctx);
}

function won(ctx: Ctx): void {
  const { s, d } = ctx;
  const a = s.arena;
  if (!a || a.phase !== 'fight') return;
  a.phase = 'won';
  a.endT = d.game.tuning.rift.returnAfterWin;
  for (const p of presentPlayers(s)) {
    p.bonds++;
    p.stats.progress.riftWins.push(a.type);
  }
  emit(ctx, { type: 'progress', event: 'rift-win', playerId: null, data: { type: a.type } });
  // The reward flies to you (only what's in the arena: the map's pickups stay where they are).
  const R = (a.r + 2) * TILE;
  for (const pk of s.pickups) if (dist2(pk.x, pk.y, a.x, a.y) < R * R) pk.pulled = true;
  emit(ctx, { type: 'arena-ended', result: 'won', dex: a.dex });
  emit(ctx, {
    type: 'say',
    key: 'hud.youDefeatedGrabYourReward',
    params: { 0: pokemonName(ctx, a.dex) },
    seconds: 3.4,
  });
}

function lost(ctx: Ctx): void {
  const a = ctx.s.arena;
  if (!a || a.phase !== 'fight') return;
  a.phase = 'lost';
  a.endT = ctx.d.game.tuning.rift.returnAfterLoss;
  emit(ctx, { type: 'arena-ended', result: 'lost', dex: a.dex });
  emit(ctx, { type: 'say', key: 'hud.theRiftThrewYouOut', seconds: 2.6 });
}

/** Back to the map: everything as it was, the downed revived. */
function finishArena(ctx: Ctx): void {
  const { s } = ctx;
  const a = s.arena;
  if (!a) return;
  s.arena = null;
  // Forget the arena: its tiles go back to normal map (and its leftovers can't be reached).
  const w = s.world;
  w.arena = null;
  const R = a.r + 9;
  const inArea = (key: string) => {
    const [tx = 0, ty = 0] = key.split(',').map(Number);
    return Math.abs(tx - a.tx) <= R && Math.abs(ty - a.ty) <= R;
  };
  for (const key of Object.keys(w.broken)) if (inArea(key)) delete w.broken[key];
  for (const key of Object.keys(w.propHp)) if (inArea(key)) delete w.propHp[key];
  const far = (R * TILE) ** 2;
  s.pickups = s.pickups.filter((pk) => dist2(pk.x, pk.y, a.x, a.y) > far);
  resetChunks(ctx);
  resetPaths(ctx);
  clearWeather(ctx);
  s.enemies = a.stash;
  rebuildGrid(ctx);
  s.projectiles = [];
  s.fields = [];
  s.hazards = [];
  const players = presentPlayers(s);
  const first = players.map((p) => a.back[p.id]).find((b) => b) ?? { x: 0, y: 0 };
  for (const p of players) {
    const b = a.back[p.id] ?? first;
    teleport(p, b.x, b.y);
    if (p.dead) revivePlayer(ctx, p, 0.3, null);
  }
  emit(ctx, { type: 'arena-left', result: a.phase === 'won' ? 'won' : 'lost' });
  if (a.phase === 'won') {
    for (const p of players) {
      if (p.bonds > 0 && !p.left && !bondOptions(p)) {
        emit(ctx, {
          type: 'say',
          key: 'hud.bondSavedLearnAnotherMove',
          seconds: 3,
          playerId: p.id,
        });
      }
    }
  }
}
