import { describe, expect, it } from 'vitest';
import { DT } from '../src/constants.js';
import { hurtEnemy, updateEnemies } from '../src/enemies.js';
import { restoreSim } from '../src/index.js';
import { player, quietSim, spawnDummy } from './helpers.js';
import { measureShields } from './measure-shields.js';

function encounter() {
  const sim = quietSim();
  const p = player(sim);
  const target = spawnDummy(sim, p.x + 140, p.y, {}, 1000);
  const caster = spawnDummy(
    sim,
    target.x + 40,
    target.y,
    {
      dex: 113,
      behavior: 'healer',
      shotCooldown: 3.5,
      range: 230,
    },
    1000,
  );
  for (const e of [target, caster]) {
    e.flying = true;
    e.r = 0;
  }
  const tuning = sim.ctx.d.game.tuning.enemyHeals;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) updateEnemies(sim.ctx);
  };
  const cast = () => {
    caster.shotCd = 0;
    tick();
  };
  const hurt = (damage: number) => hurtEnemy(sim.ctx, target, damage);
  return { sim, target, caster, tuning, tick, cast, hurt };
}

describe('enemy healing', () => {
  it('restores only the configured share of HP damage, consumes it once, and reports the recipient', () => {
    const { sim, target, tuning, hurt, cast } = encounter();
    hurt(100);
    expect(target.healCredit).toBe(100 * tuning.damageFraction);
    sim.drainEvents();
    cast();
    expect(target.hp).toBe(900 + 100 * tuning.damageFraction);
    expect(target.healCredit).toBe(0);
    expect(sim.drainEvents()).toContainEqual({
      type: 'enemy-healed',
      id: target.id,
      x: target.x,
      y: target.y,
      amount: 100 * tuning.damageFraction,
    });
    target.healCd = 0;
    const hp = target.hp;
    cast();
    expect(target.hp).toBe(hp);
  });

  it.each([100, 1000, 100000])(
    'caps stored credit and each heal at a fraction of %i max HP',
    (hp) => {
      const { target, tuning, hurt, cast } = encounter();
      target.hp = target.maxHp = hp;
      hurt(hp * 0.5);
      expect(target.healCredit).toBe(hp * tuning.maxHpFraction);
      cast();
      expect(target.hp).toBe(hp * (0.5 + tuning.maxHpFraction));
    },
  );

  it('never overheals or resurrects, and full-health targets do not consume coverage', () => {
    const { sim, target, caster, cast } = encounter();
    target.hp = target.maxHp - 1;
    target.healCredit = 100;
    caster.hp = caster.maxHp;
    caster.healCredit = 100;
    const dead = spawnDummy(sim, caster.x + 10, caster.y, {}, 1);
    dead.dead = true;
    dead.hp = 0;
    dead.healCredit = 100;
    cast();
    expect(target.hp).toBe(target.maxHp);
    expect(target.healCredit).toBe(99);
    expect(caster.hp).toBe(caster.maxHp);
    expect(caster.healCd).toBe(0);
    expect(dead.hp).toBe(0);
  });

  it('overlapping casters share the recipient cooldown even after new damage', () => {
    const { sim, target, caster, tuning, hurt, cast, tick } = encounter();
    const second = spawnDummy(sim, caster.x, caster.y, { behavior: 'healer', range: 230 });
    second.flying = true;
    second.r = 0;
    second.shotCd = 0;
    hurt(100);
    cast();
    expect(target.hp).toBe(900 + 100 * tuning.damageFraction);
    hurt(100);
    const hp = target.hp;
    for (let i = 0; i < Math.floor(tuning.recipientCooldown / DT) - 1; i++) {
      caster.shotCd = second.shotCd = 0;
      tick();
      expect(target.hp).toBe(hp);
    }
    for (let i = 0; i < 3; i++) {
      caster.shotCd = second.shotCd = 0;
      tick();
    }
    expect(target.hp).toBe(hp + 100 * tuning.damageFraction);
  });

  it('uses data for the initial/caster cooldown, including old enemy definitions', () => {
    const { sim, caster, tuning, cast, tick } = encounter();
    expect(caster.shotCd).toBeGreaterThanOrEqual(tuning.initialCooldown[0]);
    expect(caster.shotCd).toBeLessThanOrEqual(tuning.initialCooldown[1]);
    cast();
    expect(caster.shotCd).toBe(tuning.cooldown); // Fixture def still has the pre-nerf 3.5 s.
    sim.drainEvents();
    tick(Math.floor(tuning.cooldown / DT) - 1);
    expect(
      sim.drainEvents().filter((e) => e.type === 'enemy-action' && e.action === 'heal'),
    ).toHaveLength(0);
    tick(3);
    expect(
      sim.drainEvents().filter((e) => e.type === 'enemy-action' && e.action === 'heal'),
    ).toHaveLength(1);
  });

  it('heals only the nearest eligible targets, including self, within range; excludes bosses and legends', () => {
    const { sim, target, caster, tuning, cast } = encounter();
    hurtEnemy(sim.ctx, caster, 100);
    const allies = Array.from({ length: 6 }, (_, i) =>
      spawnDummy(sim, caster.x + (i + 1) * 10, caster.y, {}, 1000),
    );
    for (const e of allies) hurtEnemy(sim.ctx, e, 100);
    const boss = spawnDummy(sim, caster.x + 1, caster.y, {}, 1000);
    boss.boss = true;
    const legend = spawnDummy(sim, caster.x + 2, caster.y, {}, 1000);
    legend.legend = true;
    const outside = spawnDummy(sim, caster.x + tuning.radius + 10, caster.y, {}, 1000);
    for (const e of [boss, legend, outside]) hurtEnemy(sim.ctx, e, 100);
    for (const e of sim.state.enemies) {
      e.flying = true;
      e.r = 0;
    }
    sim.drainEvents();
    cast();
    const recipients = sim
      .drainEvents()
      .filter((e) => e.type === 'enemy-healed')
      .map((e) => e.id);
    expect(recipients).toEqual([
      caster.id,
      ...allies.slice(0, tuning.maxTargets - 1).map((e) => e.id),
    ]);
    expect(target.healCd).toBe(0);
    for (const e of [boss, legend, outside]) expect(e.hp).toBe(900);
  });

  it('shield damage earns no healing credit; overflow earns only HP credit and healing waits for exposure', () => {
    const { target, tuning, hurt, cast } = encounter();
    target.shield = 200;
    hurt(100);
    expect(target.healCredit).toBe(0);
    target.hp -= 100;
    target.healCredit = 30;
    cast();
    expect(target.hp).toBe(900);
    expect(target.healCredit).toBe(30);
    hurt(150); // 100 remaining shield + 50 actual HP.
    expect(target.shield).toBe(0);
    expect(target.healCredit).toBe(30 + 50 * tuning.damageFraction);
    cast();
    expect(target.hp).toBe(850 + 30 + 50 * tuning.damageFraction);
  });

  it('total healing never exceeds the configured fraction of real HP damage across repeated casts', () => {
    const { sim, target, caster, tuning, hurt, cast } = encounter();
    let healed = 0;
    let hpDamage = 0;
    caster.behavior = 'chase';
    for (let i = 0; i < 20; i++) {
      hurt(10);
      hpDamage += 10;
      target.healCd = 0;
      caster.behavior = 'healer';
      const hp = target.hp;
      cast();
      healed += target.hp - hp;
      caster.behavior = 'chase';
      sim.drainEvents();
    }
    expect(healed).toBeCloseTo(hpDamage * tuning.damageFraction);
    expect(target.hp).toBeCloseTo(target.maxHp - hpDamage + healed);
  });

  it('restores credit/cooldowns exactly and migrates old saves, including arena stashes', () => {
    const { sim, target, cast, hurt } = encounter();
    hurt(100);
    cast();
    hurt(50);
    expect(restoreSim(structuredClone(sim.state)).hash()).toBe(sim.hash());
    const old = structuredClone(sim.state);
    for (const e of old.enemies) {
      Reflect.deleteProperty(e, 'healCredit');
      Reflect.deleteProperty(e, 'healCd');
    }
    const restored = restoreSim(old);
    const got = restored.state.enemies.find((e) => e.id === target.id)!;
    expect(got.healCredit).toBe(0);
    expect(got.healCd).toBe(0);
    sim.debugStartArena();
    const oldArena = structuredClone(sim.state);
    for (const e of oldArena.arena!.stash) {
      Reflect.deleteProperty(e, 'healCredit');
      Reflect.deleteProperty(e, 'healCd');
    }
    const stash = restoreSim(oldArena).state.arena!.stash;
    expect(stash.every((e) => e.healCredit === 0 && e.healCd === 0)).toBe(true);
  });

  it.each([3, 8, 15])(
    'keeps minute %i healers at 1.3–1.6× and mixed support below 2.1×',
    (minute) => {
      const plain = measureShields(minute, 0).ttk!;
      for (const count of [1, 3]) {
        const heals = measureShields(minute, 0, count);
        expect(heals.ttk).not.toBeNull();
        expect(heals.ttk! + DT).toBeGreaterThanOrEqual(plain * 1.3); // One tick of tolerance.
        expect(heals.ttk! / plain).toBeLessThanOrEqual(1.6);
        const mixed = measureShields(minute, count, count);
        expect(mixed.ttk).not.toBeNull();
        expect(mixed.ttk! / plain).toBeLessThan(2.1);
      }
    },
  );
});
