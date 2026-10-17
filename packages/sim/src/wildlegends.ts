// Wild legendaries (`tuning.wildLegends`): late in the run, rare legendary mini-bosses on the map,
// so a strong late build still has something to engage or run from. Each is a `boss` (the boss
// attack kit: telegraphed slams, dashes or leaps and two ranged skills by type; no knockback,
// shields or heals; boss poison factor), its hits aren't capped like regular ones, and defence
// applies as usual. HP, damage and speed are multiples of a regular wild Pokémon of the last tier
// at the same minute (`hpCurve`, `damageCurve`, `speedCurve`), so they stay above the horde as it
// scales; HP grows with the team like the horde's (`scaleHp`).
//
// From `fromMinute` a chance every tick gives `spawnCurve` spawns per minute on average, while
// fewer than `maxAlive` are out. None appear while the team is in a rift (the ones out are
// stashed with the rest of the map). They don't count toward `spawner.cap` (`hordeSize`), don't
// slow the waves or hold up events like a boss does, and aren't counted as bosses for coins or
// missions. Their reward is modest: big XP gems, a heal, and a chance of a gem or a ticket.
import { noteWildLegendSpawn } from './balance.js';
import { DT, OUTER_RADIUS } from './constants.js';
import { activePlayers, emit, presentPlayers, type Ctx } from './ctx.js';
import { addEnemy, createEnemy, pokemonName } from './enemies.js';
import { TAU } from './math.js';
import { dropPickup } from './pickups.js';
import { legendBehavior } from './rift.js';
import { enemyScale, hordeToughness, scaleHp } from './spawner.js';
import { wildDamageMultiplier as curveAt } from './wilddamage.js';
import type { EnemyDef, EnemyState, PlayerState } from './state.js';

/** Enemies that count toward `spawner.cap`: all but the wild legendaries. */
export const hordeSize = (ctx: Ctx): number =>
  ctx.s.enemies.reduce((n, e) => n + (e.wildLegend ? 0 : 1), 0);

export const wildLegendsAlive = (ctx: Ctx): number =>
  ctx.s.enemies.reduce((n, e) => n + (e.wildLegend && !e.dead ? 1 : 0), 0);

export function updateWildLegends(ctx: Ctx): void {
  const { s, d } = ctx;
  const W = d.game.tuning.wildLegends;
  if (s.config.noSpawns || s.arena || !activePlayers(s).length) return;
  const t = s.time;
  const from = W.fromMinute * 60;
  if (t < from) return;
  if (t - DT < from) emit(ctx, { type: 'say', key: 'hud.legendsRoamTheWild', seconds: 3.6 });
  if (wildLegendsAlive(ctx) >= W.maxAlive) return;
  if (ctx.rand() < (curveAt(W.spawnCurve, t / 60) / 60) * DT) spawnWildLegend(ctx);
}

/** The anchor: a random living player. */
function anchor(ctx: Ctx): PlayerState | undefined {
  const players = activePlayers(ctx.s);
  const alive = players.filter((p) => !p.dead);
  return alive.length ? ctx.rand.pick(alive) : (players[0] ?? presentPlayers(ctx.s)[0]);
}

/** A legendary as a regular wild Pokémon of the last tier (the run's scaling and curves go on top). */
export function wildLegendDef(ctx: Ctx, dex: number): EnemyDef {
  const { d } = ctx;
  const mon = d.game.pokemonByDex.get(dex);
  if (!mon) throw new Error(`unknown Pokémon ${dex}`);
  const base = d.enemyDef(mon, d.game.enemies.tiers.length - 1);
  return {
    dex,
    behavior: legendBehavior(mon),
    hp: base.hp,
    speed: base.speed,
    damage: base.damage,
    xp: base.xp,
    // A ranged regular's shot is 0.8 of its contact (`enemyDef`); the boss skills scale from it.
    shotDamage: Math.round(base.damage * 0.8),
    shotCooldown: 0.9,
    range: 300,
  };
}

/**
 * A wild legendary near a random living player (`dex`: this one; default a random legendary not
 * already out). Also for tests and the debug view.
 */
export function spawnWildLegend(ctx: Ctx, dex?: number): EnemyState | null {
  const { s, d, rand } = ctx;
  const W = d.game.tuning.wildLegends;
  const out = new Set(s.enemies.filter((e) => e.wildLegend && !e.dead).map((e) => e.dex));
  let pick = dex;
  if (pick === undefined) {
    const pool = d.game.pokedex.filter((p) => p.legendary && d.hasSprite(p.dex) && !out.has(p.dex));
    if (!pool.length) return null;
    pick = rand.pick(pool).dex;
  }
  const pl = anchor(ctx);
  if (!pl) return null;
  const t = s.time;
  const minute = t / 60;
  const tuning = d.game.tuning.spawner;
  const n = activePlayers(s).length;
  const regular = enemyScale(ctx, t);
  const def = wildLegendDef(ctx, pick);
  const a = rand() * TAU;
  const r = OUTER_RADIUS + rand.range(20, 60);
  const e = createEnemy(
    ctx,
    def,
    pl.x + Math.cos(a) * r,
    pl.y + Math.sin(a) * r * 0.9,
    {
      hp: regular.hp * scaleHp(n) * hordeToughness(t) * curveAt(W.hpCurve, minute),
      damage: regular.damage * tuning.damageK * curveAt(W.damageCurve, minute),
      speed: regular.speed * curveAt(W.speedCurve, minute),
    },
    true,
  );
  e.wildLegend = true;
  e.xp = Math.round(def.xp * tuning.xpK * W.xpMultiplier);
  addEnemy(ctx, e);
  noteWildLegendSpawn(ctx, e);
  emit(ctx, {
    type: 'say',
    key: 'hud.aWildLegendAppeared',
    params: { 0: pokemonName(ctx, e.dex) },
    seconds: 3.4,
  });
  return e;
}

/** Its loot: `xpGems` big XP gems, a heal, and maybe a gem and a ticket. */
export function dropWildLegendLoot(ctx: Ctx, e: EnemyState): void {
  const { rand } = ctx;
  const W = ctx.d.game.tuning.wildLegends;
  const each = Math.ceil(e.xp / W.xpGems);
  for (let i = 0; i < W.xpGems; i++) {
    const a = rand() * TAU;
    const r = rand.range(10, 60);
    dropPickup(ctx, 'xp-big', e.x + Math.cos(a) * r, e.y + Math.sin(a) * r, each);
  }
  dropPickup(ctx, 'heal', e.x + 24, e.y);
  if (rand() < W.gemChance) dropPickup(ctx, 'gem', e.x, e.y + 20, 1);
  if (rand() < W.ticketChance) dropPickup(ctx, 'ticket', e.x - 20, e.y + 10, 1);
  emit(ctx, {
    type: 'say',
    key: 'hud.youDefeatedTheWild',
    params: { 0: pokemonName(ctx, e.dex) },
    seconds: 2.8,
  });
}
