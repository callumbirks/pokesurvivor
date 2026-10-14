import { describe, expect, it } from 'vitest';
import { DT } from '../src/constants.js';
import { hurtEnemy, updateEnemies } from '../src/enemies.js';
import { restoreSim } from '../src/index.js';
import { player, quietSim, seconds, spawnDummy } from './helpers.js';
import { measureShields } from './measure-shields.js';

function encounter() {
  const sim = quietSim();
  const p = player(sim);
  const target = spawnDummy(sim, p.x + 300, p.y, {}, 1000);
  const caster = spawnDummy(sim, target.x + 40, target.y, { behavior: 'shielder' }, 1000);
  for (const e of [target, caster]) {
    e.flying = true;
    e.r = 0;
  }
  const tuning = sim.ctx.d.game.tuning.enemyShields;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) updateEnemies(sim.ctx);
  };
  const cast = () => {
    caster.skillCd = 0;
    tick();
  };
  return { sim, target, caster, tuning, tick, cast };
}

describe('enemy shields', () => {
  it.each([100, 1000, 100000])('caps absorption at the configured fraction of %i max HP', (hp) => {
    const { sim, target, tuning, cast } = encounter();
    target.hp = target.maxHp = hp;
    cast();
    expect(target.shield).toBe(hp * tuning.maxHpFraction);
    hurtEnemy(sim.ctx, target, target.shield + 10);
    expect(target.shield).toBe(0);
    expect(target.hp).toBe(hp - 10);
  });

  it('expires on time, even on a thief that returns early from its behaviour', () => {
    const { target, caster, tuning, tick, cast } = encounter();
    cast();
    caster.behavior = 'chase';
    target.behavior = 'thief';
    tick(seconds(tuning.duration) - 1);
    expect(target.shield).toBeGreaterThan(0);
    tick(2);
    expect(target.shield).toBe(0);
    expect(target.shieldT).toBe(0);
  });

  it('overlapping casters cannot stack, refill or extend a live shield', () => {
    const { sim, target, caster, tuning, tick, cast } = encounter();
    cast();
    hurtEnemy(sim.ctx, target, 50);
    const remaining = target.shield;
    const expires = target.shieldT;
    const second = spawnDummy(sim, caster.x, caster.y, { behavior: 'shielder' });
    second.flying = true;
    second.r = 0;
    second.skillCd = 0;
    cast();
    expect(target.shield).toBe(remaining);
    expect(target.shieldT).toBeCloseTo(expires - DT);
    caster.behavior = second.behavior = 'chase';
    tick(seconds(tuning.duration));
    expect(target.shield).toBe(0);
  });

  it('a broken shield cannot be replaced by another caster until the recipient cooldown ends', () => {
    const { sim, target, caster, tuning, tick, cast } = encounter();
    cast();
    hurtEnemy(sim.ctx, target, target.shield);
    const second = spawnDummy(sim, caster.x, caster.y, { behavior: 'shielder' });
    second.flying = true;
    second.r = 0;
    for (let i = 0; i < seconds(tuning.reapplyCooldown) - 1; i++) {
      caster.skillCd = second.skillCd = 0;
      tick();
      expect(target.shield).toBe(0);
    }
    for (let i = 0; i < 2; i++) {
      second.skillCd = 0;
      tick();
    }
    expect(target.shield).toBe(target.maxHp * tuning.maxHpFraction);
  });

  it('uses the configured initial and recurring caster cooldowns', () => {
    const { sim, caster, tuning, tick, cast } = encounter();
    expect(caster.skillCd).toBeGreaterThanOrEqual(tuning.initialCooldown[0]);
    expect(caster.skillCd).toBeLessThanOrEqual(tuning.initialCooldown[1]);
    cast();
    expect(caster.skillCd).toBe(tuning.cooldown);
    sim.drainEvents();
    tick(seconds(tuning.cooldown) - 1);
    expect(
      sim.drainEvents().filter((e) => e.type === 'enemy-action' && e.action === 'shield'),
    ).toHaveLength(0);
    tick(2);
    expect(
      sim.drainEvents().filter((e) => e.type === 'enemy-action' && e.action === 'shield'),
    ).toHaveLength(1);
  });

  it('covers only the nearest configured targets, includes self, and respects range and boss exclusions', () => {
    const { sim, caster, tuning, cast } = encounter();
    const allies = Array.from({ length: 6 }, (_, i) =>
      spawnDummy(sim, caster.x + 10 * (i + 1), caster.y),
    );
    const boss = spawnDummy(sim, caster.x + 1, caster.y);
    boss.boss = true;
    const legend = spawnDummy(sim, caster.x + 2, caster.y);
    legend.legend = true;
    const outside = spawnDummy(sim, caster.x + tuning.radius + 50, caster.y);
    for (const e of sim.state.enemies) {
      e.flying = true;
      e.r = 0;
    }
    cast();
    expect(sim.state.enemies.filter((e) => e.shield > 0).map((e) => e.id)).toEqual([
      caster.id,
      ...allies.slice(0, tuning.maxTargets - 1).map((e) => e.id),
    ]);
    expect(boss.shield).toBe(0);
    expect(legend.shield).toBe(0);
    expect(outside.shield).toBe(0);
  });

  it('migrates old solo saves and arena stashes without losing shield cooldowns on new saves', () => {
    const { sim, target, tuning, cast } = encounter();
    cast();
    const restored = restoreSim(structuredClone(sim.state));
    expect(restored.hash()).toBe(sim.hash());
    const old = structuredClone(sim.state);
    const enemy = old.enemies.find((e) => e.id === target.id)!;
    Reflect.deleteProperty(enemy, 'shieldCd');
    enemy.shield = enemy.maxHp * 0.35;
    enemy.shieldT = 8;
    const migrated = restoreSim(old).state.enemies.find((e) => e.id === target.id)!;
    expect(migrated.shield).toBe(migrated.maxHp * tuning.maxHpFraction);
    expect(migrated.shieldT).toBe(tuning.duration);
    expect(migrated.shieldCd).toBe(tuning.reapplyCooldown);
    sim.debugStartArena();
    const oldArena = structuredClone(sim.state);
    const stashed = oldArena.arena!.stash.find((e) => e.id === target.id)!;
    Reflect.deleteProperty(stashed, 'shieldCd');
    stashed.shield = stashed.maxHp * 0.35;
    stashed.shieldT = 8;
    const migratedStash = restoreSim(oldArena).state.arena!.stash.find((e) => e.id === target.id)!;
    expect(migratedStash.shield).toBe(stashed.maxHp * tuning.maxHpFraction);
    expect(migratedStash.shieldT).toBe(tuning.duration);
    expect(migratedStash.shieldCd).toBe(tuning.reapplyCooldown);
  });

  it.each([3, 8, 15])(
    'keeps representative minute %i kill times within 1.3–1.6×, even with three casters',
    (minute) => {
      const plain = measureShields(minute, 0);
      for (const casters of [1, 3]) {
        const shielded = measureShields(minute, casters);
        expect(shielded.ttk).not.toBeNull();
        const ratio = shielded.ttk! / plain.ttk!;
        expect(ratio).toBeGreaterThanOrEqual(1.3);
        expect(ratio).toBeLessThanOrEqual(1.6);
      }
    },
  );
});
