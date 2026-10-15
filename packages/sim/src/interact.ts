// Interactables (original implementation): the world places them (rare, on open floor); this is
// what happens when someone touches them.
//   altar      grants a 25 s power (Fury, Lightning, Magnet or Haste), once
//   spring     heals while you stand in it; it drains and refills on its own
//   big-chest  stand next to it for a few seconds (while under attack) and it opens: coins,
//              tickets and the XP for a level
//   trap       goes off when stepped on (by a player or a walking enemy) and hits everything
//              around: poison, sticky (slows) or explosive
// Legacy ran altars and springs on each player's own machine; here they are shared (an altar is
// used up for everyone, a spring's charge is the same for everyone).
import { DT } from './constants.js';
import { activePlayers, emit, presentPlayers, type Ctx } from './ctx.js';
import { applyStatus, hurtEnemy, queryEnemies } from './enemies.js';
import { dist2 } from './math.js';
import { dropPickup, dropXp } from './pickups.js';
import { hurtPlayer } from './players.js';
import { xpToNextLevel } from './team.js';
import { destroyProp, rollItem, specialsNear, type Prop } from './world.js';
import type { PlayerState } from './state.js';

/** Players check interactables this close; enemies set off traps this close to a player. */
const NEAR = 120;
const TRAP_WATCH = 720;
/** Spring healing is reported in `player-healed` every this many ticks. */
const HEAL_REPORT_TICKS = 18;

// ---------------------------------------------------------------- altar powers

function powerDef(ctx: Ctx, id: string) {
  return ctx.d.game.world.altarPowers.find((pw) => pw.id === id);
}

function applyPower(ctx: Ctx, p: PlayerState, id: string, on: boolean): void {
  const e = powerDef(ctx, id)?.effect;
  if (!e) return;
  p[e.stat] = on ? p[e.stat] * e.value : p[e.stat] / e.value;
}

/** Ends a player's altar power (it ran out, or a new one replaces it). */
export function endPower(ctx: Ctx, p: PlayerState): void {
  if (!p.power) return;
  applyPower(ctx, p, p.power.id, false);
  p.power = null;
}

function usePower(ctx: Ctx, p: PlayerState, altar: Prop): void {
  const w = ctx.d.game.world;
  ctx.s.world.altarsUsed[altar.key] = 1;
  const pw = w.altarPowers[altar.kind % w.altarPowers.length];
  if (!pw) return;
  endPower(ctx, p);
  applyPower(ctx, p, pw.id, true);
  p.power = { id: pw.id, t: w.altarPowerSeconds };
  emit(ctx, { type: 'altar', playerId: p.id, key: altar.key, powerId: pw.id });
  emit(ctx, {
    type: 'say',
    key: 'hud.powerForS',
    params: { 0: pw.name, 1: pw.description, 2: w.altarPowerSeconds },
    seconds: 3,
    playerId: p.id,
  });
}

// ---------------------------------------------------------------- springs

function spring(ctx: Ctx, p: PlayerState, prop: Prop, d2: number): void {
  const cfg = ctx.d.game.world.spring;
  const springs = ctx.s.world.springs;
  const charge = springs[prop.key] ?? 1;
  if (d2 > cfg.range * cfg.range || charge <= 0.02 || p.hp >= p.maxHp) return;
  const heal = Math.min(p.maxHp - p.hp, p.maxHp * cfg.healPerSecond * DT);
  p.hp += heal;
  p.springHeal += heal;
  const left = Math.max(0, charge - DT * cfg.drainPerSecond);
  springs[prop.key] = left;
  if (left <= 0.02) {
    emit(ctx, {
      type: 'say',
      key: 'hud.theSpringHasDriedUp',
      seconds: 2.2,
      playerId: p.id,
    });
  }
}

// ---------------------------------------------------------------- per tick

export function updateInteract(ctx: Ctx): void {
  const { s, d } = ctx;
  const w = s.world;
  const refill = DT / d.game.world.spring.refillSeconds;
  for (const [key, c] of Object.entries(w.springs)) {
    if (c + refill >= 1) delete w.springs[key];
    else w.springs[key] = c + refill;
  }

  for (const p of presentPlayers(s)) {
    if (p.power && !p.dead && (p.power.t -= DT) <= 0) endPower(ctx, p);
    if (p.springHeal >= 1 && s.tick % HEAL_REPORT_TICKS === 0) {
      emit(ctx, { type: 'player-healed', playerId: p.id, amount: Math.round(p.springHeal) });
      p.springHeal = 0;
    }
  }

  const chestsNear = new Map<string, Prop>();
  const traps = new Map<string, Prop>();
  for (const p of activePlayers(s)) {
    for (const prop of specialsNear(ctx, p.x, p.y, TRAP_WATCH)) {
      if (prop.type === 'trap') traps.set(prop.key, prop);
      if (p.dead) continue;
      const py = prop.type === 'spring' || prop.type === 'trap' ? prop.y - 8 : prop.y;
      const d2 = dist2(p.x, p.y, prop.x, py);
      if (d2 > NEAR * NEAR) continue;
      switch (prop.type) {
        case 'spring':
          spring(ctx, p, prop, d2);
          break;
        case 'altar':
          // Counting your size: a big Pokémon bumps into the altar before getting within 30.
          if (!w.altarsUsed[prop.key] && d2 < Math.max(30, prop.r + p.r + 14) ** 2) {
            usePower(ctx, p, prop);
          }
          break;
        case 'big-chest':
          if (d2 < Math.max(46, prop.r + p.r + 24) ** 2) chestsNear.set(prop.key, prop);
          break;
        case 'trap':
          if (d2 < 13 * 13) {
            traps.delete(prop.key);
            destroyProp(ctx, prop);
          }
          break;
      }
    }
  }

  // Locked chests: progress while anyone stands by (not faster with more), else it slips back.
  const openAfter = d.game.world.bigChestOpenSeconds;
  for (const [key, prop] of chestsNear) {
    const t = (w.chests[key] ?? 0) + DT;
    if (t >= openAfter) {
      delete w.chests[key];
      destroyProp(ctx, prop);
    } else w.chests[key] = t;
  }
  for (const [key, t] of Object.entries(w.chests)) {
    if (chestsNear.has(key)) continue;
    const left = t - DT * 1.5;
    if (left <= 0) delete w.chests[key];
    else w.chests[key] = left;
  }

  // A walking enemy that steps on a trap sets it off.
  for (const prop of traps.values()) {
    if (queryEnemies(ctx, prop.x, prop.y - 8, 3).some((e) => !e.flying)) destroyProp(ctx, prop);
  }
}

// ---------------------------------------------------------------- breaking

/** A locked chest opened or a trap went off (world.ts `destroyProp`). */
export function onSpecialBroken(ctx: Ctx, p: Prop): void {
  if (p.type === 'big-chest') openChest(ctx, p);
  else if (p.type === 'trap') trapGoesOff(ctx, p);
}

/** The big loot: coins, tickets (sometimes a ×10), maybe an item, and the XP for a level. */
function openChest(ctx: Ctx, p: Prop): void {
  const { rand, s } = ctx;
  for (let i = 0; i < 9; i++) {
    dropPickup(ctx, 'coin', p.x + rand.range(-22, 22), p.y + rand.range(-14, 14), 4);
  }
  const tickets = rand.int(1, 3);
  for (let i = 0; i < tickets; i++) {
    dropPickup(ctx, 'ticket', p.x + rand.range(-16, 16), p.y + rand.range(-10, 10), 1);
  }
  if (rand() < 0.15) dropPickup(ctx, 'ticket10', p.x, p.y - 10, 1);
  if (rand() < 0.5) dropPickup(ctx, 'item', p.x + 14, p.y - 14, 0, rollItem(ctx));
  dropXp(ctx, p.x, p.y, xpToNextLevel(ctx));
  // Everyone in the run gets it for their missions (like defeats).
  for (const pl of presentPlayers(s)) pl.stats.progress.chestsOpened++;
  emit(ctx, { type: 'progress', event: 'chest', playerId: null, data: {} });
}

function trapGoesOff(ctx: Ctx, p: Prop): void {
  const { s, d } = ctx;
  const traps = d.game.world.traps;
  const t = traps[p.kind % traps.length];
  if (!t) return;
  const R = d.game.world.trapRadius;
  const x = p.x;
  const y = p.y - 8;
  emit(ctx, { type: 'trap', key: p.key, trap: t.id, x, y, r: R });
  // It hurts enemies too.
  for (const e of queryEnemies(ctx, x, y, R)) {
    if (t.enemyPoison) applyStatus(e, { burn: 0, poison: t.enemyPoison, slow: 0, knockback: 0 });
    if (t.enemySlow) {
      e.slow = Math.max(e.slow, t.enemySlow);
      e.slowT = Math.max(e.slowT, t.enemySlowSeconds);
    }
    hurtEnemy(ctx, e, t.enemyDamage + s.team.level * t.enemyDamagePerLevel, {
      dirX: e.x - x,
      dirY: e.y - y,
      knockback: t.knockback,
    });
  }
  for (const pl of activePlayers(s)) {
    if (pl.dead || dist2(x, y, pl.x, pl.y) >= (R * 0.7) ** 2) continue;
    pl.invuln = 0;
    if (t.playerMaxHpDamage)
      hurtPlayer(ctx, pl, pl.maxHp * t.playerMaxHpDamage, null, false, { kind: 'trap' });
    if (t.playerSlowSeconds) {
      pl.slowT = t.playerSlowSeconds;
      emit(ctx, { type: 'say', key: 'hud.sticky', seconds: 1.5, playerId: pl.id });
    }
  }
}
