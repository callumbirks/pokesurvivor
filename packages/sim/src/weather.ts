// Weather (original implementation): from minute 2, a roll every minute may bring a weather
// that lasts about a minute. It changes the damage of attacks by type, for players and enemies
// alike (weather.json):
//   sun   Fire ×1.5 · Water ×0.5          rain  Water ×1.5 · Electric ×1.2 · Fire ×0.5
//   sand  Rock, Ground, Steel ×1.3; everyone else loses a little HP
//   snow  Ice ×1.5; everyone else loses a little HP and slows down
//   fog   Ghost, Fairy, Psychic ×1.3
// Each run biome has its likelier weathers; each rift arena forces its own. Effects fade in and
// out over a few seconds.
import { DT } from './constants.js';
import { activePlayers, emit, type Ctx } from './ctx.js';
import { hurtEnemy } from './enemies.js';
import { clamp } from './math.js';
import type { PokemonType, WeatherFile, WeatherId } from '@pokesurvivor/data';

type WeatherKind = WeatherFile['kinds'][number];

function kindOf(ctx: Ctx, id: WeatherId): WeatherKind | undefined {
  return ctx.d.game.weather.kinds.find((k) => k.id === id);
}

function current(ctx: Ctx): WeatherKind | undefined {
  const c = ctx.s.weather.current;
  return c ? kindOf(ctx, c.kind) : undefined;
}

/** Strength of the current weather, 0–1 (it fades in and out). */
export function weatherLevel(ctx: Ctx): number {
  const c = ctx.s.weather.current;
  if (!c) return 0;
  const fade = ctx.d.game.weather.fadeSeconds;
  return clamp(Math.min(1, c.t / fade, (c.dur - c.t) / fade), 0, 1);
}

/** Damage multiplier for attacks of `type` under the current weather. */
export function weatherDamageMult(ctx: Ctx, type: PokemonType | null): number {
  const k = current(ctx);
  const m = type ? k?.multipliers[type] : undefined;
  return m ? 1 + (m - 1) * weatherLevel(ctx) : 1;
}

/** Speed multiplier for a Pokémon of these types under the current weather (snow slows). */
export function weatherSpeedMult(ctx: Ctx, types: readonly PokemonType[]): number {
  const k = current(ctx);
  if (!k?.slows || types.includes('ice')) return 1;
  return 1 - ctx.d.game.weather.slow * weatherLevel(ctx);
}

/** Does the current weather chip away at a Pokémon of these types (sand, snow)? */
export function weatherHurts(ctx: Ctx, types: readonly PokemonType[]): boolean {
  const safe = current(ctx)?.immuneTypes;
  return !!safe && !types.some((t) => safe.includes(t));
}

export function startWeather(ctx: Ctx, kind: WeatherId, dur: number): void {
  ctx.s.weather.current = { kind, t: 0, dur };
  const k = kindOf(ctx, kind);
  emit(ctx, { type: 'weather', kind, seconds: dur });
  if (k) {
    emit(ctx, {
      type: 'say',
      key: 'hud.weatherStarts',
      params: { 0: k.name, 1: k.hint },
      seconds: 3.4,
    });
  }
}

/** Clears the weather at once (leaving the arena). */
export function clearWeather(ctx: Ctx): void {
  if (!ctx.s.weather.current) return;
  ctx.s.weather.current = null;
  emit(ctx, { type: 'weather', kind: null, seconds: 0 });
}

/** A weather for this run biome, by its weights. */
export function pickWeather(ctx: Ctx, biome: number): WeatherId {
  const all = ctx.d.game.weather.biomeWeights;
  const w = all[biome % all.length] ?? {};
  const entries = Object.entries(w) as [WeatherId, number][];
  let r = ctx.rand() * entries.reduce((a, [, v]) => a + v, 0);
  for (const [k, v] of entries) {
    r -= v;
    if (r <= 0) return k;
  }
  return 'rain';
}

export function updateWeather(ctx: Ctx): void {
  const { s, d, rand } = ctx;
  const w = s.weather;
  const data = d.game.weather;
  if (w.current) {
    w.current.t += DT;
    if (w.current.t >= w.current.dur) {
      w.current = null;
      emit(ctx, { type: 'weather', kind: null, seconds: 0 });
    }
  } else if (s.time > data.startAfter && !s.arena) {
    w.checkT -= DT;
    if (w.checkT <= 0) {
      w.checkT = data.checkEvery;
      if (rand() < data.chance) {
        const [lo, hi] = data.durationRange;
        startWeather(ctx, pickWeather(ctx, s.world.biome), Math.round(rand.range(lo, hi)));
      }
    }
  }

  // Sand and snow chip away at whoever isn't immune (never knocking a player out).
  w.chipT -= DT;
  if (w.chipT > 0) return;
  const chip = data.chip;
  w.chipT = chip.every;
  if (!current(ctx)?.immuneTypes || weatherLevel(ctx) <= chip.minIntensity) return;
  for (const p of activePlayers(s)) {
    if (p.dead || s.config.invulnerable || !weatherHurts(ctx, p.types)) continue;
    const dmg = Math.max(1, p.maxHp * chip.playerMaxHp);
    if (p.hp <= dmg + 1) continue;
    p.hp -= dmg;
    emit(ctx, { type: 'player-hurt', playerId: p.id, amount: Math.round(dmg), label: null });
  }
  for (const e of s.enemies) {
    if (e.dead || e.boss || !weatherHurts(ctx, e.types)) continue;
    hurtEnemy(ctx, e, e.maxHp * chip.enemyMaxHp + chip.enemyFlat);
  }
}
