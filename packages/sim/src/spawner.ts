// Waves, bosses and shinies (original implementation and data/enemies.js rollRun/scale).
// Enemies appear on a ring just outside everyone's view, so they never pop in on screen. Every
// ~45 s a surge rushes in from one side. With several players they spawn around a random living
// one, more often and tougher (`scaleRate` / `scaleHp`).
import { DT, OUTER_RADIUS } from './constants.js';
import { activePlayers, emit, presentPlayers, type Ctx } from './ctx.js';
import { addEnemy, createEnemy, makeGolden, makeShiny, pokemonName } from './enemies.js';
import { goldenHour, hordeBag } from './runevents.js';
import { TAU, dist2 } from './math.js';
import { isFree } from './world.js';
import { wildDamageMultiplier } from './wilddamage.js';
import type {
  BossDef,
  EnemyDef,
  EnemyScale,
  EnemyState,
  PlayerState,
  RosterState,
  RosterTier,
} from './state.js';
import type { Pokemon, EnemyBehavior } from '@pokesurvivor/data';

/** Co-op difficulty: spawn rate and HP per extra player (original implementation). */
export const scaleRate = (n: number): number => 1 + 0.75 * Math.max(0, n - 1);
export const scaleHp = (n: number): number => 1 + 0.3 * Math.max(0, n - 1);

/** Extra toughness that grows with the run: ×3.3 at the start, up to ×5 around minute 6. */
const hpK = (t: number) => 3.3 + Math.min(1.7, t / 210);

/** Enemies per second at second `t`. */
export function spawnRate(ctx: Ctx, t: number): number {
  return (1.6 + t * 0.028 + Math.pow(t / 60, 1.6) * 0.5) * ctx.d.game.tuning.spawner.density;
}

export const spawnCap = (ctx: Ctx): number => ctx.d.game.tuning.spawner.cap;

/** Regular enemy scaling at second `t` (late game included). */
export function enemyScale(ctx: Ctx, t: number): EnemyScale {
  const k = ctx.d.late(t);
  return {
    hp: (1 + t / 95) * k,
    damage: wildDamageMultiplier(ctx.d.game.tuning.spawner.damageCurve, t / 60) * Math.pow(k, 0.7),
    speed: 1 + Math.min(0.35, t / 1400),
  };
}

/** Bosses already have a growing base HP (1,400 … 16,000), so they scale much more gently. */
export function bossScale(ctx: Ctx, t: number): EnemyScale {
  const k = ctx.d.late(t);
  return { hp: (1 + t / 600) * k, damage: (1 + t / 600) * Math.pow(k, 0.7), speed: 1 };
}

// ---------------------------------------------------------------- the run's roster

const PLAIN: readonly EnemyBehavior[] = ['chase', 'charger', 'ranged', 'tank'];
const SUPPORT: readonly EnemyBehavior[] = ['healer', 'shielder', 'summoner'];

/**
 * A tier's cast: always one support (healer, shielder or summoner) and, from the second tier, one
 * that attacks with a warning. The first tier has no other personalities (to learn the ropes).
 */
function castFor(ctx: Ctx, ti: number): Pokemon[] {
  const { d, rand } = ctx;
  const tier = d.game.enemies.tiers[ti];
  const all = d.tierCandidates[ti] ?? [];
  if (!tier) return [];
  const kind = (p: Pokemon) => d.behaviorOf(p);
  const kinds = SUPPORT.filter((k) => all.some((p) => kind(p) === k));
  const sk = kinds.length ? kinds[Math.floor(rand() * kinds.length)] : null;
  const pick = sk
    ? rand.pickN(
        all.filter((p) => kind(p) === sk),
        1,
      )
    : [];
  if (tier.from > 0) {
    pick.push(
      ...rand.pickN(
        all.filter((p) => !PLAIN.includes(kind(p)) && !SUPPORT.includes(kind(p))),
        1,
      ),
    );
  }
  const rest =
    tier.from === 0
      ? all.filter((p) => !pick.includes(p) && PLAIN.includes(kind(p)))
      : all.filter((p) => !pick.includes(p));
  return pick.concat(rand.pickN(rest, tier.castSize - pick.length));
}

/** Rolls the run's wild Pokémon: a cast per tier (one becomes the runner) and the bosses. */
export function rollRoster(ctx: Ctx): RosterState {
  const { d, rand } = ctx;
  const tiers: RosterTier[] = d.game.enemies.tiers.map((tier, ti) => ({
    from: tier.from,
    list: castFor(ctx, ti).map((p) => d.enemyDef(p, ti)),
  }));
  // One runner per tier: the fastest plain one, faster still and frailer.
  for (const tier of tiers) {
    const plain = tier.list.filter(
      (e) => e.behavior === 'chase' || e.behavior === 'charger' || e.behavior === 'tank',
    );
    const r = plain.sort((a, b) => b.speed - a.speed)[0];
    if (r) {
      r.behavior = 'runner';
      r.speed = Math.round(r.speed * 1.6);
      r.hp = Math.round(r.hp * 0.7);
    }
  }
  const used = new Set<number>();
  const bosses: BossDef[] = d.game.enemies.bossSlots.map((slot, si) => {
    const ok = (p: Pokemon) => !p.legendary && d.hasSprite(p.dex) && !used.has(p.dex);
    let pool = d.game.pokedex.filter((p) => ok(p) && p.bst >= slot.bst[0] && p.bst <= slot.bst[1]);
    if (!pool.length) pool = d.game.pokedex.filter((p) => ok(p) && p.bst >= 580);
    const p = rand.pick(pool);
    used.add(p.dex);
    return d.bossDef(p, si);
  });
  return { tiers, bosses };
}

/** A random enemy def available at second `t` (old tiers lose weight after 260 s). */
function pickDef(ctx: Ctx, t: number): EnemyDef {
  // During a typed horde only that type spawns.
  const horde = hordeBag(ctx);
  if (horde) return ctx.rand.pick(horde);
  const tiers = ctx.s.roster.tiers;
  let total = 0;
  for (const tier of tiers)
    if (t >= tier.from) total += tier.list.length * (t - tier.from > 260 ? 3 : 10);
  if (!total) return ctx.rand.pick(tiers[0]?.list ?? []);
  let i = Math.floor(ctx.rand() * total);
  for (const tier of tiers) {
    if (t < tier.from) continue;
    const w = t - tier.from > 260 ? 3 : 10;
    const n = tier.list.length * w;
    if (i < n) return tier.list[Math.floor(i / w)] as EnemyDef;
    i -= n;
  }
  return tiers[0]?.list[0] as EnemyDef;
}

// ---------------------------------------------------------------- placement

function ringPoint(ctx: Ctx, pl: PlayerState, angle: number): [number, number] {
  const d = OUTER_RADIUS + ctx.rand.range(10, 70);
  return [pl.x + Math.cos(angle) * d, pl.y + Math.sin(angle) * d * 0.9];
}

/** Would anyone see it? (So nothing appears in front of a teammate.) */
function seenByAnyone(players: PlayerState[], x: number, y: number): boolean {
  const r = OUTER_RADIUS - 30;
  return players.some((o) => dist2(o.x, o.y, x, y) < r * r);
}

/** A point on the ring with room for it: not in a wall or water. */
function freePoint(
  ctx: Ctx,
  pl: PlayerState,
  angle: number,
  flying: boolean,
  allowed?: (x: number, y: number) => boolean,
): [number, number] | null {
  const players = activePlayers(ctx.s);
  for (let i = 0; i < 8; i++) {
    const a = angle + (i === 0 ? 0 : ctx.rand.range(-0.9, 0.9));
    const [x, y] = ringPoint(ctx, pl, a);
    if (allowed && !allowed(x, y)) continue;
    if (players.length > 1 && seenByAnyone(players, x, y)) continue;
    if (flying || isFree(ctx, x, y, 14)) return [x, y];
  }
  return null;
}

/** The player the next enemy spawns around: a random living one. */
function anchor(ctx: Ctx): PlayerState | undefined {
  const players = activePlayers(ctx.s);
  const alive = players.filter((p) => !p.dead);
  return alive.length ? ctx.rand.pick(alive) : (players[0] ?? presentPlayers(ctx.s)[0]);
}

const scaled = (sc: EnemyScale, k: number): EnemyScale => (k === 1 ? sc : { ...sc, hp: sc.hp * k });

function rollShiny(ctx: Ctx, dex: number): boolean {
  if (!ctx.d.body(dex).shiny) return false;
  if (ctx.s.spawner.forceShiny > 0) {
    ctx.s.spawner.forceShiny--;
    return true;
  }
  return ctx.rand() < ctx.d.game.tuning.spawner.shinyRate;
}

export function spawnOne(ctx: Ctx, pl: PlayerState, t: number, angle?: number): EnemyState | null {
  const { d, s } = ctx;
  const tuning = d.game.tuning.spawner;
  const def = pickDef(ctx, t);
  const spawnAngle = angle ?? arrivalAngle(ctx, pl);
  const heading = travelHeading(ctx, pl);
  // Retry terrain within the sampled half, rather than moving a rejected rear arrival ahead.
  const ahead = heading !== null && Math.cos(spawnAngle - heading) >= 0;
  const allowed =
    angle !== undefined || heading === null
      ? undefined
      : (x: number, y: number) => {
          const dot = (x - pl.x) * Math.cos(heading) + (y - pl.y) * Math.sin(heading);
          return ahead ? dot >= 0 : dot <= 0;
        };
  const pt = freePoint(ctx, pl, spawnAngle, d.body(def.dex).hovers, allowed);
  if (!pt) return null;
  const shiny = rollShiny(ctx, def.dex);
  const n = activePlayers(s).length;
  const e = createEnemy(ctx, def, pt[0], pt[1], scaled(enemyScale(ctx, t), scaleHp(n) * hpK(t)));
  // Fewer but tougher enemies than the original game (`density`), with more damage and XP each.
  e.damage *= tuning.damageK;
  e.regularHit = true;
  e.xp = Math.round(e.xp * tuning.xpK);
  // At the cap, new ones are elites, so the difficulty doesn't drop.
  if (s.enemies.length >= tuning.cap * tuning.eliteFrom) {
    e.regularHit = false;
    e.maxHp = e.hp = Math.round(e.maxHp * 1.6);
    e.damage *= 1.25;
    e.xp = Math.round(e.xp * 1.6);
  }
  if (shiny) makeShiny(e);
  if (goldenHour(ctx)) makeGolden(e);
  addEnemy(ctx, e);
  if (shiny)
    emit(ctx, {
      type: 'say',
      key: 'hud.aShinyIsNearby',
      params: { 0: pokemonName(ctx, e.dex) },
      seconds: 3.4,
    });
  return e;
}

function spawnBoss(ctx: Ctx, pl: PlayerState, t: number, b: BossDef): EnemyState {
  const n = activePlayers(ctx.s).length;
  const [x, y] = ringPoint(ctx, pl, ctx.rand() * TAU);
  const e = createEnemy(
    ctx,
    b,
    x,
    y,
    scaled(bossScale(ctx, t), scaleHp(n) * (n > 1 ? 1.4 : 1)),
    true,
  );
  if (rollShiny(ctx, b.dex)) makeShiny(e);
  addEnemy(ctx, e);
  emit(ctx, {
    type: 'say',
    key: e.shiny ? 'hud.aWildShinyAppeared' : 'hud.aWildAppeared',
    params: { 0: pokemonName(ctx, e.dex) },
    seconds: 3.2,
  });
  return e;
}

const bossAlive = (ctx: Ctx) => ctx.s.enemies.some((e) => e.boss && !e.dead);

export function updateSpawner(ctx: Ctx): void {
  const { s, d, rand } = ctx;
  const sp = s.spawner;
  const t = s.time;
  const cap = d.game.tuning.spawner.cap;
  const n = activePlayers(s).length;
  if (!n || s.config.noSpawns) return;
  // Nothing spawns while the team is in a rift arena (and the next boss waits).
  if (s.arena) return;

  const lateFrom = d.game.enemies.lateGame.fromMinute * 60;
  if (t >= lateFrom && t - DT < lateFrom) {
    emit(ctx, { type: 'say', key: 'hud.wildPokemonAreGettingStronger', seconds: 3.6 });
  }

  // --- bosses ---
  const b = s.roster.bosses[sp.bossIndex];
  if (b && t >= b.at) {
    const at = anchor(ctx);
    if (at) spawnBoss(ctx, at, t, b);
    sp.bossIndex++;
  }

  // Boss fight: waves drop to 25% and no surges, so the boss is its own moment and can be aimed at.
  const bossFight = bossAlive(ctx);

  // --- trickle ---
  if (s.enemies.length < cap) {
    sp.acc += spawnRate(ctx, t) * scaleRate(n) * (bossFight ? 0.25 : 1) * DT;
    let k = Math.floor(sp.acc);
    sp.acc -= k;
    while (k-- > 0 && s.enemies.length < cap) {
      const at = anchor(ctx);
      if (at) spawnOne(ctx, at, t);
    }
  }

  // --- surge ---
  if (!bossFight) sp.surgeT -= DT;
  if (sp.surgeT <= 0) {
    sp.surgeT = rand.range(38, 56);
    const target = anchor(ctx);
    const base = target ? arrivalAngle(ctx, target) : 0;
    const count = Math.min(
      cap - s.enemies.length,
      Math.round((14 + Math.floor(t / 22)) * scaleRate(n) * 0.4),
    );
    if (target)
      for (let i = 0; i < count; i++) spawnOne(ctx, target, t, base + rand.range(-0.55, 0.55));
    emit(ctx, { type: 'say', key: 'hud.pokemonSwarm', seconds: 2.2 });
  }
}

/** A few at once from one side (hordes start with this). */
export function spawnBurst(ctx: Ctx, count: number): void {
  const target = anchor(ctx);
  if (!target) return;
  const base = arrivalAngle(ctx, target);
  for (let i = 0; i < count && ctx.s.enemies.length < spawnCap(ctx) + 10; i++) {
    spawnOne(ctx, target, ctx.s.time, base + ctx.rand.range(-0.6, 0.6));
  }
}

/** Recent travel, not current input. A stopped/slow player gets uniform arrivals. */
export function travelHeading(ctx: Ctx, pl: PlayerState): number | null {
  const speed = Math.hypot(pl.travelVx, pl.travelVy);
  return speed > 1e-6 && speed >= ctx.d.game.tuning.spawner.directionBias.minSpeed
    ? Math.atan2(pl.travelVy, pl.travelVx)
    : null;
}

/** Small forward share, otherwise the rear half including the sides. */
export function arrivalAngle(ctx: Ctx, pl: PlayerState): number {
  const heading = travelHeading(ctx, pl);
  if (heading === null) return ctx.rand() * TAU;
  const ahead = ctx.rand() < ctx.d.game.tuning.spawner.directionBias.aheadShare;
  return heading + (ahead ? -Math.PI / 2 : Math.PI / 2) + ctx.rand() * Math.PI;
}

/** A straggler rejoins outside everyone's view, usually rearward with a small forward share.
 * Placement retries obey the selected forward half or rear arc, including the elliptical ring.
 * On failure the manager keeps the enemy walking and retries; it is never discarded.
 */
export function rejoinPlayer(ctx: Ctx, e: EnemyState, pl: PlayerState): boolean {
  const heading = travelHeading(ctx, pl);
  const tuning = ctx.d.game.tuning.stragglers;
  const halfArc = (tuning.rearArcDegrees * Math.PI) / 360;
  const ahead = heading !== null && ctx.rand() < tuning.aheadShare;
  const angle =
    heading === null
      ? ctx.rand() * TAU
      : ahead
        ? heading + ctx.rand.range(-Math.PI / 2, Math.PI / 2)
        : heading + Math.PI + ctx.rand.range(-halfArc, halfArc);
  const allowed =
    heading === null
      ? undefined
      : (x: number, y: number) => {
          const dx = x - pl.x,
            dy = y - pl.y;
          const dot = dx * Math.cos(heading) + dy * Math.sin(heading);
          return ahead ? dot >= 0 : dot <= -Math.cos(halfArc) * Math.hypot(dx, dy) + 1e-9;
        };
  const pt = freePoint(ctx, pl, angle, e.flying, allowed);
  if (!pt) return false;
  e.x = pt[0];
  e.y = pt[1];
  e.kx = e.ky = 0;
  e.phase = 'walk';
  e.pt = 0;
  e.jump = null;
  return true;
}
