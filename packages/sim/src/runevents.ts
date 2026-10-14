// Mid-run events and treasure thieves (original implementation). Every 4–5 minutes (never with a
// boss alive or in a rift arena) one of these happens, never the same one twice in a row:
//   horde  30 s in which every spawn is of one type (if your type beats it, it's your moment)
//   gold   golden hour: 30 s of golden enemies that give double XP and sometimes coins
//   lost   a lost Pokémon: touch it, it follows you; take it to the marker. Enemies hurt it; if it
//          faints (or you take more than 2 minutes) it leaves. Reward: half your HP back, coins,
//          a ticket and, 1 time in 5, it joins your collection.
// Treasure thieves (two per run, `thief` behaviour): a Meowth loaded with coins or, with
// `goldThiefChance`, a Gholdengo with a ×10 ticket. It runs away and escapes after 15 s.
// Everyone sees the same event and the rewards are for everyone.
import { DT } from './constants.js';
import { activePlayers, emit, presentPlayers, type Ctx } from './ctx.js';
import { addEnemy, createEnemy, makeGolden, pokemonName, queryEnemies } from './enemies.js';
import { TAU, dist, dist2, norm } from './math.js';
import { dropPickup } from './pickups.js';
import { healPlayer, speedOf } from './players.js';
import { scaleRate, spawnBurst } from './spawner.js';
import { collide, isFree } from './world.js';
import type { EnemyBehavior, PokemonType } from '@pokesurvivor/data';
import type { EnemyDef, PlayerState, RunEventId } from './state.js';

/** Treasure thieves per run. */
const MAX_THIEVES = 2;
const MEOWTH = 52;
const GHOLDENGO = 1000;
/** Retry delays while a boss is alive (legacy). */
const THIEF_RETRY = 8;
const EVENT_RETRY = 10;
/** Behaviours that don't make sense in a horde. */
const NO_HORDE: ReadonlySet<EnemyBehavior> = new Set(['bomber', 'healer', 'shielder', 'summoner']);
/** Lost Pokémon: it gets home within this distance of the marker. */
const HOME_RANGE = 56;

export const bossAlive = (ctx: Ctx): boolean => ctx.s.enemies.some((e) => e.boss && !e.dead);

/** Golden hour: new spawns are golden. */
export const goldenHour = (ctx: Ctx): boolean => ctx.s.events.current?.id === 'gold';

/** During a typed horde only these spawn (original `Events.bag()`). */
export function hordeBag(ctx: Ctx): EnemyDef[] | null {
  const c = ctx.s.events.current;
  return c?.id === 'horde' && c.defs.length ? c.defs : null;
}

function livingAnchor(ctx: Ctx): PlayerState | undefined {
  const players = activePlayers(ctx.s);
  const alive = players.filter((p) => !p.dead);
  return alive.length ? ctx.rand.pick(alive) : players[0];
}

// ---------------------------------------------------------------- hordes

function tierAt(ctx: Ctx, t: number): number {
  let ti = 0;
  ctx.d.game.enemies.tiers.forEach((tier, i) => {
    if (t >= tier.from) ti = i;
  });
  return ti;
}

function hordePool(ctx: Ctx, t: number) {
  const { d } = ctx;
  return (d.tierCandidates[tierAt(ctx, t)] ?? []).filter((p) => !NO_HORDE.has(d.behaviorOf(p)));
}

/** Types with enough Pokémon in the current tier for a horde (3+). */
export function hordeTypes(ctx: Ctx, t: number): PokemonType[] {
  const all = hordePool(ctx, t);
  return ctx.d.game.types.types
    .map((ty) => ty.id)
    .filter((ty) => all.filter((p) => p.types.includes(ty)).length >= 3);
}

/** Up to 4 Pokémon of a type, with the current tier's stats. */
function hordeDefs(ctx: Ctx, type: PokemonType, t: number): EnemyDef[] {
  const ti = tierAt(ctx, t);
  const pool = hordePool(ctx, t).filter((p) => p.types.includes(type));
  return ctx.rand.pickN(pool, 4).map((p) => ctx.d.enemyDef(p, ti));
}

// ---------------------------------------------------------------- the cycle

export function updateRunEvents(ctx: Ctx): void {
  const { s, d, rand } = ctx;
  const ev = s.events;
  const T = d.game.tuning.events;
  const cur = ev.current;
  if (cur) {
    cur.t += DT;
    if (cur.dur !== null && cur.t >= cur.dur) endEvent(ctx);
  }
  // (The lost Pokémon waits on the map while the team is in a rift arena.)
  if (ev.lost && !s.arena) lostTick(ctx);
  if (s.arena || s.config.noSpawns || !activePlayers(s).length) return;

  if (ev.thieves < MAX_THIEVES) {
    ev.thiefT -= DT;
    if (ev.thiefT <= 0) {
      if (bossAlive(ctx)) ev.thiefT = THIEF_RETRY;
      else {
        spawnThief(ctx);
        ev.thieves++;
        ev.thiefT = rand.range(T.thiefNext[0], T.thiefNext[1]);
      }
    }
  }

  if (ev.current) return;
  ev.nextT -= DT;
  if (ev.nextT > 0) return;
  if (bossAlive(ctx)) {
    ev.nextT = EVENT_RETRY;
    return;
  }
  ev.nextT = rand.range(T.every[0], T.every[1]);
  const ids = (['horde', 'gold', 'lost'] as const).filter((id) => id !== ev.last);
  startEvent(ctx, rand.pick(ids));
}

/** Starts an event now (also for tests and the debug view). */
export function startEvent(ctx: Ctx, id: RunEventId): void {
  const { s, d, rand } = ctx;
  const ev = s.events;
  const T = d.game.tuning.events;
  ev.last = id;
  if (id === 'horde') {
    const types = hordeTypes(ctx, s.time);
    if (!types.length) {
      startEvent(ctx, 'gold');
      return;
    }
    const type = rand.pick(types);
    ev.current = { id, t: 0, dur: T.duration, type, defs: hordeDefs(ctx, type, s.time) };
    spawnBurst(ctx, Math.round(T.hordeBurst * scaleRate(activePlayers(s).length)));
    emit(ctx, { type: 'run-event', id, phase: 'start', pokemonType: type });
    const name = d.game.types.types.find((t) => t.id === type)?.name ?? type;
    emit(ctx, { type: 'say', key: 'hud.aTypeHorde', params: { 0: name }, seconds: 3 });
  } else if (id === 'gold') {
    ev.current = { id, t: 0, dur: T.duration, type: null, defs: [] };
    for (const e of s.enemies) if (!e.dead) makeGolden(e);
    emit(ctx, { type: 'run-event', id, phase: 'start' });
    emit(ctx, { type: 'say', key: 'hud.goldenHourDoubleExperience', seconds: 3 });
  } else {
    if (!spawnLost(ctx)) return;
    ev.current = { id, t: 0, dur: null, type: null, defs: [] };
    const dex = ev.lost?.dex ?? 0;
    emit(ctx, { type: 'run-event', id, phase: 'start', dex });
    emit(ctx, {
      type: 'say',
      key: 'hud.aIsLostFindIt',
      params: { 0: pokemonName(ctx, dex) },
      seconds: 3.4,
    });
  }
}

function endEvent(ctx: Ctx): void {
  const cur = ctx.s.events.current;
  if (!cur) return;
  ctx.s.events.current = null;
  emit(ctx, { type: 'run-event', id: cur.id, phase: 'end' });
}

// ---------------------------------------------------------------- treasure thieves

/** A treasure thief appears near a living player (also for tests and the debug view). */
export function spawnThief(ctx: Ctx): void {
  const { s, d, rand } = ctx;
  const gold = rand() < d.game.tuning.events.goldThiefChance;
  const dex = gold ? GHOLDENGO : MEOWTH;
  if (!d.game.pokemonByDex.has(dex) || !d.hasSprite(dex)) return;
  const pl = livingAnchor(ctx);
  if (!pl) return;
  const def: EnemyDef = {
    dex,
    behavior: 'thief',
    hp: Math.round(60 * (1 + s.time / 95) * (gold ? 1.5 : 1)),
    speed: 92,
    damage: 0,
    xp: 10,
    loot: gold ? 'ticket10' : 'coins',
  };
  for (let i = 0; i < 12; i++) {
    const a = rand() * TAU;
    const r = rand.range(230, 300);
    const x = pl.x + Math.cos(a) * r;
    const y = pl.y + Math.sin(a) * r * 0.8;
    if (!isFree(ctx, x, y, 14)) continue;
    const e = createEnemy(ctx, def, x, y, { hp: 1, speed: 1, damage: 1 });
    e.life = d.game.tuning.events.thiefLife;
    addEnemy(ctx, e);
    emit(ctx, { type: 'thief', id: e.id, dex, loot: def.loot ?? 'coins' });
    emit(ctx, {
      type: 'say',
      key: gold ? 'hud.aWithAX10Ticket' : 'hud.aLoadedWithCoinsCatch',
      params: { 0: pokemonName(ctx, dex) },
      seconds: 3.2,
    });
    return;
  }
}

// ---------------------------------------------------------------- the lost Pokémon

function spawnLost(ctx: Ctx): boolean {
  const { s, d, rand } = ctx;
  const pl = livingAnchor(ctx);
  if (!pl) return false;
  const pool = d.game.pokedex.filter(
    (p) => p.rarity <= 3 && !p.legendary && d.hasSprite(p.dex) && !d.body(p.dex).hovers,
  );
  const mon = rand.pick(pool);
  let at: [number, number] | null = null;
  let to: [number, number] | null = null;
  for (let i = 0; i < 20 && !at; i++) {
    const a = rand() * TAU;
    const r = rand.range(220, 300);
    const x = pl.x + Math.cos(a) * r;
    const y = pl.y + Math.sin(a) * r * 0.8;
    if (isFree(ctx, x, y, 16)) at = [x, y];
  }
  for (let i = 0; i < 30 && at && !to; i++) {
    const a = rand() * TAU;
    const r = rand.range(700, 850);
    const x = at[0] + Math.cos(a) * r;
    const y = at[1] + Math.sin(a) * r * 0.85;
    if (isFree(ctx, x, y, 30)) to = [x, y];
  }
  if (!at || !to) return false;
  s.events.lost = {
    dex: mon.dex,
    x: at[0],
    y: at[1],
    r: d.body(mon.dex).radius,
    hp: 100,
    maxHp: 100,
    phase: 'wait',
    follow: null,
    moving: false,
    face: Math.PI / 2,
    tx: to[0],
    ty: to[1],
    t: 0,
    hitCd: 0,
    joins: rand() < d.game.tuning.events.lostJoinChance,
  };
  return true;
}

function lostTick(ctx: Ctx): void {
  const { s } = ctx;
  const L = s.events.lost;
  if (!L) return;
  L.t += DT;
  const alive = activePlayers(s).filter((p) => !p.dead);
  if (L.phase === 'wait') {
    L.moving = false;
    const p = alive.find((o) => dist2(o.x, o.y, L.x, L.y) < (o.r + L.r + 18) ** 2);
    if (p) {
      L.phase = 'follow';
      L.follow = p.id;
      emit(ctx, { type: 'lost-pokemon', phase: 'found', dex: L.dex, playerId: p.id });
      emit(ctx, {
        type: 'say',
        key: 'hud.isFollowingYouTakeIt',
        params: { 0: pokemonName(ctx, L.dex) },
        seconds: 3,
      });
    }
  } else {
    const lead = alive.find((o) => o.id === L.follow);
    const p = lead ?? alive[0] ?? presentPlayers(s).find((o) => o.id === L.follow);
    if (p) {
      const d = dist(L.x, L.y, p.x, p.y);
      const keep = p.r + L.r + 14;
      L.moving = d > keep;
      if (L.moving) {
        const step = Math.min(d - keep, Math.max(120, speedOf(ctx, p) * 1.15) * DT);
        const [nx, ny] = norm(p.x - L.x, p.y - L.y);
        L.x += nx * step;
        L.y += ny * step;
        collide(ctx, L);
        L.face = Math.atan2(ny, nx);
      }
    }
    if (dist2(L.x, L.y, L.tx, L.ty) < HOME_RANGE * HOME_RANGE) {
      rescued(ctx);
      return;
    }
  }

  // Enemies that touch it hurt it.
  if ((L.hitCd -= DT) <= 0) {
    const hits = queryEnemies(ctx, L.x, L.y, L.r).filter((e) => e.behavior !== 'thief');
    if (hits.length) {
      L.hitCd = 0.5;
      L.hp -= Math.min(
        30,
        hits.reduce((a, e) => a + 4 + e.damage * 0.12, 0),
      );
      emit(ctx, { type: 'lost-pokemon', phase: 'hurt', dex: L.dex });
      if (L.hp <= 0) {
        gone(ctx, 'scared');
        return;
      }
    }
  }
  if (L.t > ctx.d.game.tuning.events.lostTime) gone(ctx, 'tired');
}

function rescued(ctx: Ctx): void {
  const { s, rand } = ctx;
  const L = s.events.lost;
  if (!L) return;
  for (let i = 0; i < 12; i++) {
    dropPickup(ctx, 'coin', L.tx + rand.range(-40, 40), L.ty + rand.range(-30, 30), 5);
  }
  dropPickup(ctx, 'ticket', L.tx, L.ty - 12, 1);
  for (const p of presentPlayers(s)) {
    if (!p.dead) healPlayer(ctx, p, p.maxHp * 0.5);
    // It joins everyone's collection (each client tells "already owned" from its own save).
    if (L.joins) p.stats.progress.rescued.push(L.dex);
  }
  emit(ctx, { type: 'lost-pokemon', phase: 'rescued', dex: L.dex, joins: L.joins });
  if (L.joins) {
    emit(ctx, { type: 'progress', event: 'rescue', playerId: null, data: { dex: L.dex } });
  }
  emit(ctx, {
    type: 'say',
    key: L.joins ? 'hud.joinsYourTeam' : 'hud.youBroughtHomeItThanks',
    params: { 0: pokemonName(ctx, L.dex) },
    seconds: L.joins ? 4 : 3.2,
  });
  s.events.lost = null;
  endEvent(ctx);
}

function gone(ctx: Ctx, why: 'scared' | 'tired'): void {
  const L = ctx.s.events.lost;
  if (!L) return;
  emit(ctx, { type: 'lost-pokemon', phase: why, dex: L.dex });
  emit(ctx, {
    type: 'say',
    key: why === 'scared' ? 'hud.gotScaredAndRanAway' : 'hud.gotTiredOfWaitingAnd',
    params: { 0: pokemonName(ctx, L.dex) },
    seconds: 3,
  });
  ctx.s.events.lost = null;
  endEvent(ctx);
}
