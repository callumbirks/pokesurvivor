import { expect, it } from 'vitest';
import { resolveCollisions } from '../src/combat.js';
import { rebuildGrid } from '../src/enemies.js';
import { hurtPlayer } from '../src/players.js';
import { spawnProjectile } from '../src/projectiles.js';
import { enemyScale, spawnOne } from '../src/spawner.js';
import { weatherDamageMult } from '../src/weather.js';
import { capRegularHit, wildDamageMultiplier } from '../src/wilddamage.js';
import { quietSim } from './helpers.js';

it('interpolates configured wild damage and caps only marked contact/shots before weather', () => {
  const sim = quietSim();
  const { damageCurve: points, regularHitCapFraction: cap } = sim.ctx.d.game.tuning.spawner;
  for (const [i, point] of points.entries()) {
    expect(wildDamageMultiplier(points, point.minute)).toBe(point.multiplier);
    expect(enemyScale(sim.ctx, point.minute * 60).damage).toBeCloseTo(
      point.multiplier * sim.ctx.d.late(point.minute * 60) ** 0.7,
    );
    if (i) {
      const previous = points[i - 1]!;
      expect(wildDamageMultiplier(points, (point.minute + previous.minute) / 2)).toBeCloseTo(
        (point.multiplier + previous.multiplier) / 2,
      );
    }
  }
  expect(wildDamageMultiplier(points, -1)).toBe(points[0]!.multiplier);
  expect(wildDamageMultiplier(points, points.at(-1)!.minute + 1)).toBe(points.at(-1)!.multiplier);
  const p = sim.state.players[0]!;
  p.moves = [];
  const raw = p.maxHp * 2;
  const expected = cap > 0 ? p.maxHp * cap : raw;
  expect(capRegularHit(raw, p.maxHp, cap)).toBe(expected);
  expect(capRegularHit(raw, p.maxHp, 0)).toBe(raw);
  expect(capRegularHit(expected / 2, p.maxHp, cap)).toBe(expected / 2);
  const reset = () => {
    p.hp = p.maxHp;
    p.dead = false;
    p.invuln = 0;
  };
  const enemy = spawnOne(sim.ctx, p, 0)!;
  expect(enemy.regularHit).toBe(true);
  enemy.x = p.x;
  enemy.y = p.y;
  enemy.damage = raw;
  enemy.attackType = 'normal';
  rebuildGrid(sim.ctx);
  resolveCollisions(sim.ctx);
  expect(p.hp).toBeCloseTo(Math.max(0, p.maxHp - expected));
  sim.state.enemies = [];
  rebuildGrid(sim.ctx);
  reset();
  spawnProjectile(sim.ctx, {
    x: p.x,
    y: p.y,
    r: 1,
    damage: raw,
    friendly: false,
    regularHit: true,
  });
  resolveCollisions(sim.ctx);
  expect(p.hp).toBeCloseTo(Math.max(0, p.maxHp - expected));
  reset();
  const weather = sim.ctx.d.game.weather;
  const sunny = weather.kinds.find((kind) => (kind.multipliers.fire ?? 0) > 1)!;
  sim.state.weather.current = {
    kind: sunny.id,
    t: weather.fadeSeconds,
    dur: weather.fadeSeconds * 4,
  };
  p.types = ['grass'];
  hurtPlayer(sim.ctx, p, raw, 'fire', true);
  const beforeWeather = capRegularHit(raw * sim.ctx.d.typeMult('fire', p.types), p.maxHp, cap);
  expect(p.hp).toBeCloseTo(
    Math.max(0, p.maxHp - beforeWeather * weatherDamageMult(sim.ctx, 'fire')),
  );
  reset();
  // Unmarked elite/boss/legend/skill hits retain their full damage.
  hurtPlayer(sim.ctx, p, raw, null);
  expect(p.dead).toBe(true);
});

it('multiplies regular wild HP by the configured HP curve', () => {
  const sim = quietSim();
  const { hpCurve } = sim.ctx.d.game.tuning.spawner;
  for (const point of hpCurve) {
    const t = point.minute * 60;
    expect(wildDamageMultiplier(hpCurve, point.minute)).toBe(point.multiplier);
    expect(enemyScale(sim.ctx, t).hp).toBeCloseTo(
      (1 + t / 95) * sim.ctx.d.late(t) * point.multiplier,
    );
  }
  const last = hpCurve.at(-1)!;
  expect(wildDamageMultiplier(hpCurve, last.minute + 5)).toBe(last.multiplier);
});
