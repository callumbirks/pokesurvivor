// Weather: type multipliers (fading in and out), schedule and biome weights, chip damage, slow.
import { describe, expect, it } from 'vitest';
import { simData } from '../src/data.js';
import { pickWeather, weatherDamageMult, weatherLevel, weatherSpeedMult } from '../src/weather.js';
import { damageTo, giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const W = simData().game.weather;
const sun = W.kinds.find((k) => k.id === 'sun')!;
const rain = W.kinds.find((k) => k.id === 'rain')!;

describe('weather', () => {
  it('multiplies damage by attack type, fading in and out', () => {
    const sim = quietSim();
    const { ctx } = sim;
    expect(weatherDamageMult(ctx, 'fire')).toBe(1);
    sim.debugStartWeather('sun', 20);
    steps(sim, seconds(W.fadeSeconds / 2));
    expect(weatherLevel(ctx)).toBeCloseTo(0.5, 1);
    expect(weatherDamageMult(ctx, 'fire')).toBeCloseTo(
      1 + ((sun.multipliers.fire ?? 1) - 1) / 2,
      1,
    );
    steps(sim, seconds(W.fadeSeconds));
    expect(weatherDamageMult(ctx, 'fire')).toBeCloseTo(sun.multipliers.fire ?? 1);
    expect(weatherDamageMult(ctx, 'water')).toBeCloseTo(sun.multipliers.water ?? 1);
    expect(weatherDamageMult(ctx, 'grass')).toBe(1);
    steps(sim, seconds(20 - W.fadeSeconds * 1.5) + 1);
    expect(sim.state.weather.current).toBeNull();
    expect(weatherDamageMult(ctx, 'fire')).toBe(1);
  });

  it("changes players' damage to enemies by the configured weather multiplier", () => {
    const hit = (sun: boolean) => {
      const sim = quietSim();
      const p = player(sim);
      giveMove(sim, p, 'water-gun');
      if (sun) sim.debugStartWeather('rain', 60);
      steps(sim, seconds(W.fadeSeconds + 0.5));
      const e = spawnDummy(sim, p.x + 60, p.y);
      sim.drainEvents();
      steps(sim, seconds(3));
      return damageTo(sim.drainEvents(), e.id);
    };
    const plain = hit(false);
    expect(plain).toBeGreaterThan(0);
    expect(hit(true) / plain).toBeCloseTo(rain.multipliers.water ?? 1, 1);
  });

  it('snow slows everyone but Ice types', () => {
    const sim = quietSim();
    sim.debugStartWeather('snow', 60);
    steps(sim, seconds(W.fadeSeconds + 0.5));
    expect(weatherSpeedMult(sim.ctx, ['electric'])).toBeCloseTo(1 - W.slow);
    expect(weatherSpeedMult(sim.ctx, ['ice', 'water'])).toBe(1);
  });

  it('sand chips non-immune players and enemies, never knocking a player out', () => {
    const sim = quietSim([
      { id: 'pika', dex: 25 },
      { id: 'geo', dex: 74 },
    ]);
    const [pika, geo] = [player(sim, 0), player(sim, 1)];
    for (const p of [pika, geo]) {
      giveMove(sim, p, 'harden');
      p.regen = 0;
    }
    const enemy = spawnDummy(sim, 600, 600, {}, 1000);
    sim.debugStartWeather('sand', 60);
    steps(sim, seconds(W.fadeSeconds + 0.1));
    const [hp0, ghp0, ehp0] = [pika.hp, geo.hp, enemy.hp];
    steps(sim, seconds(W.chip.every * 3));
    const per = Math.max(1, pika.maxHp * W.chip.playerMaxHp);
    expect(hp0 - pika.hp).toBeCloseTo(per * 3, 5);
    expect(geo.hp).toBe(ghp0);
    expect(ehp0 - enemy.hp).toBeGreaterThanOrEqual(
      Math.round(1000 * W.chip.enemyMaxHp + W.chip.enemyFlat) * 3 - 3,
    );
    pika.hp = per + 1;
    steps(sim, seconds(W.chip.every * 3));
    expect(pika.hp).toBe(per + 1);
    expect(pika.dead).toBe(false);
  });

  it('follows the schedule: none before startAfter, then rolls every checkEvery s', () => {
    const sim = quietSim();
    const starts: number[] = [];
    while (sim.state.time < 15 * 60) {
      sim.step();
      for (const e of sim.drainEvents())
        if (e.type === 'weather' && e.kind) starts.push(sim.state.time);
    }
    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0]).toBeGreaterThan(W.startAfter);
    for (const t of starts) {
      // Rolls happen on the checkEvery grid counted from startAfter, shifted by weathers in between.
      expect(t).toBeGreaterThan(W.startAfter + W.checkEvery - 0.1);
    }
  }, 30_000);

  it('picks only configured weather kinds at their biome weights', () => {
    const sim = quietSim();
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(pickWeather(sim.ctx, 2));
    expect([...seen].sort()).toEqual(
      Object.entries(W.biomeWeights[2]!)
        .filter(([, weight]) => weight > 0)
        .map(([kind]) => kind)
        .sort(),
    );
    const forest = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const k = pickWeather(sim.ctx, 0);
      forest.set(k, (forest.get(k) ?? 0) + 1);
    }
    const weights = W.biomeWeights[0]!;
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    for (const [kind, weight] of Object.entries(weights)) {
      const chance = weight / total;
      const tolerance = 5 * Math.sqrt((chance * (1 - chance)) / 2000) + 1 / 2000;
      expect(Math.abs((forest.get(kind) ?? 0) / 2000 - chance)).toBeLessThanOrEqual(tolerance);
    }
  });
});
