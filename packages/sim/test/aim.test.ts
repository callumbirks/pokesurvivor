import { describe, expect, it } from 'vitest';
import { facingOf, isAttacking, restoreSim } from '../src/index.js';
import { damageTo, giveMove, player, quietSim, seconds, spawnDummy, steps } from './helpers.js';

const angleGap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/**
 * One player with one move, enemy A close on the left (the auto target) and enemy B further on the
 * right. Returns the damage each took over `secs`, with `aim` as the input's manual aim.
 */
function duel(
  move: string,
  aim: number | null,
  ax: number,
  bx: number,
  secs = 1.5,
  tweak?: (stats: Record<string, number | undefined>) => void,
) {
  const sim = quietSim();
  const p = player(sim);
  giveMove(sim, p, move);
  tweak?.(p.moves[0]!.stats);
  const a = spawnDummy(sim, p.x + ax, p.y);
  const b = spawnDummy(sim, p.x + bx, p.y);
  const x0 = p.x;
  sim.setInput(p.id, { moveX: 0, moveY: 0, aim });
  sim.drainEvents();
  steps(sim, seconds(secs));
  const events = sim.drainEvents();
  return { sim, p, x0, a: damageTo(events, a.id), b: damageTo(events, b.id), events };
}

// Aim right (0) while the auto target is on the left.
const RIGHT = 0;

describe('manual aim', () => {
  // [move, A's x (left), B's x (right)]: B is out of the auto-aimed attack's way.
  const aimed: [string, number, number, ((s: Record<string, number | undefined>) => void)?][] = [
    ['tackle', -40, 50], // melee
    ['ember', -100, 150], // projectile
    ['flamethrower', -60, 100], // cone
    ['hydro-pump', -80, 120], // beam
    ['razor-leaf', -80, 120, (s) => (s.count = 1)], // boomerang
    ['quick-attack', -60, 80], // dash
    ['thunderbolt', -100, 150], // chain (B is too far from A for a jump)
    ['rock-slide', -100, 150], // meteor
  ];

  for (const [move, ax, bx, tweak] of aimed) {
    it(`steers ${move}: auto hits the target, manual hits where it points`, () => {
      const auto = duel(move, null, ax, bx, 1.5, tweak);
      expect(auto.a).toBeGreaterThan(0);
      const first = auto.events.find((e) => e.type === 'cast');
      expect(first?.type === 'cast' && angleGap(first.aim, Math.PI)).toBeLessThan(0.01);
      const manual = duel(move, RIGHT, ax, bx, 1.5, tweak);
      expect(manual.b).toBeGreaterThan(0);
      expect(manual.a).toBe(0);
      expect(manual.p.aim).toBe(RIGHT);
      // Every cast reports the manual aim.
      const casts = manual.events.filter((e) => e.type === 'cast');
      expect(casts.length).toBeGreaterThan(0);
      for (const c of casts) if (c.type === 'cast') expect(c.aim).toBe(RIGHT);
    });
  }

  it('auto meteors fall on any enemy near; manual ones only in the aim cone', () => {
    const auto = duel('rock-slide', null, -100, 150);
    expect(auto.a).toBeGreaterThan(0);
    expect(auto.b).toBeGreaterThan(0);
    // With nobody in the cone, they land along the aim.
    const { sim, p } = duel('rock-slide', RIGHT, -100, 600, 0.2);
    const meteors = sim.state.fields.filter((f) => f.kind === 'meteor');
    expect(meteors.length).toBeGreaterThan(0);
    for (const f of meteors) {
      expect(f.x).toBeGreaterThan(p.x + 50);
      expect(angleGap(Math.atan2(f.y - p.y, f.x - p.x), RIGHT)).toBeLessThan(0.3);
    }
  });

  it('dashes the way it points', () => {
    expect(duel('quick-attack', null, -60, 80, 0.2).p.x).toBeLessThan(0);
    expect(duel('quick-attack', RIGHT, -60, 80, 0.2).p.x).toBeGreaterThan(0);
  });

  it('puts turrets behind the aim', () => {
    const fieldX = (aim: number | null) => {
      const { sim } = duel('will-o-wisp', aim, -100, 400, 0.2);
      const f = sim.state.fields.find((x) => x.kind === 'turret');
      if (!f) throw new Error('no turret');
      return f.x;
    };
    expect(fieldX(null)).toBeGreaterThan(0); // target on the left: behind is right
    expect(fieldX(RIGHT)).toBeLessThan(0);
  });

  it('a chain waits for an enemy in the aim cone', () => {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, 'thunderbolt');
    spawnDummy(sim, p.x - 100, p.y);
    sim.setInput(p.id, { moveX: 0, moveY: 0, aim: RIGHT });
    sim.drainEvents();
    steps(sim, seconds(1.5));
    expect(sim.drainEvents().some((e) => e.type === 'cast')).toBe(false);
    sim.setInput(p.id, { moveX: 0, moveY: 0, aim: Math.PI });
    steps(sim, seconds(1.5));
    expect(sim.drainEvents().some((e) => e.type === 'cast')).toBe(true);
  });

  it('leaves auras and novas alone', () => {
    for (const move of ['grass-knot', 'heat-wave']) {
      const auto = duel(move, null, -40, 50);
      const manual = duel(move, RIGHT, -40, 50);
      expect(manual.a).toBe(auto.a);
      expect(manual.b).toBe(auto.b);
      expect(manual.a).toBeGreaterThan(0);
    }
  });

  it('goes back to auto-aim when the input stops sending an aim', () => {
    const { sim, p } = duel('ember', RIGHT, -100, 150, 0.2);
    sim.setInput(p.id, { moveX: 0, moveY: 0 });
    expect(p.input.aim).toBeNull();
    steps(sim, 2);
    expect(angleGap(p.aim, Math.PI)).toBeLessThan(0.01);
  });

  it('wraps and rejects bad angles', () => {
    const sim = quietSim();
    const p = player(sim);
    sim.setInput(p.id, { moveX: 0, moveY: 0, aim: Math.PI * 2.5 });
    expect(p.input.aim).toBeCloseTo(Math.PI / 2);
    sim.setInput(p.id, { moveX: 0, moveY: 0, aim: Number.NaN });
    expect(p.input.aim).toBeNull();
  });

  it('a Pokémon attacking with manual aim faces its aim', () => {
    const { sim, p } = duel('ember', RIGHT, -100, 150, 0.6);
    const attacking = isAttacking(sim.state.time, p);
    expect(attacking).toBe(true);
    const face = facingOf({ attacking, walking: p.walking, aim: p.aim, moveAngle: p.moveAngle });
    expect(face).toBe(RIGHT);
  });

  it('is deterministic and survives a restore (states saved without an aim too)', () => {
    const run = () => duel('rock-slide', 1, -100, 150, 1).sim.hash();
    expect(run()).toBe(run());
    const { sim } = duel('ember', null, -100, 150, 0.2);
    const old = JSON.parse(JSON.stringify(sim.state)) as typeof sim.state;
    // A checkpoint from before manual aim: no `aim` in the input. It auto-aims.
    delete (old.players[0]!.input as { aim?: unknown }).aim;
    const restored = restoreSim(old);
    steps(restored, 3);
    expect(angleGap(restored.state.players[0]!.aim, Math.PI)).toBeLessThan(0.01);
  });
});

describe('fire held', () => {
  /** One move, nobody around; `fire` held (or not) with the aim pointing up. */
  function alone(move: string, fire: boolean, aim: number | null = -Math.PI / 2) {
    const sim = quietSim();
    const p = player(sim);
    giveMove(sim, p, move);
    sim.setInput(p.id, { moveX: 0, moveY: 0, aim, fire });
    sim.drainEvents();
    steps(sim, seconds(1.2));
    return { sim, p, casts: sim.drainEvents().filter((e) => e.type === 'cast') };
  }

  for (const move of ['ember', 'flamethrower', 'hydro-pump', 'tackle', 'quick-attack'])
    it(`fires ${move} along the aim with no enemy in reach, as the cooldown allows`, () => {
      const held = alone(move, true);
      expect(held.casts.length).toBeGreaterThan(0);
      for (const c of held.casts) if (c.type === 'cast') expect(c.aim).toBe(-Math.PI / 2);
      expect(alone(move, false).casts).toHaveLength(0);
    });

  it('shots fly the aimed way', () => {
    const { sim, p } = alone('ember', true, 0.5);
    const shots = sim.state.projectiles.filter((q) => q.ownerId === p.id);
    expect(shots.length).toBeGreaterThan(0);
    for (const q of shots) expect(angleGap(Math.atan2(q.vy, q.vx), 0.5)).toBeLessThan(0.1);
  });

  it('meteors land along the aim; a chain still needs an enemy in the cone', () => {
    const met = alone('rock-slide', true, 0);
    expect(met.casts.length).toBeGreaterThan(0);
    const fields = met.sim.state.fields.filter((f) => f.kind === 'meteor');
    for (const f of fields)
      expect(angleGap(Math.atan2(f.y - met.p.y, f.x - met.p.x), 0)).toBeLessThan(0.3);
    expect(alone('thunderbolt', true).casts).toHaveLength(0);
  });

  it('means nothing in auto-aim, and stops when released', () => {
    expect(alone('ember', true, null).casts).toHaveLength(0);
    const { sim, p } = alone('ember', true);
    expect(p.input.fire).toBe(true);
    sim.setInput(p.id, { moveX: 0, moveY: 0, aim: 0 });
    expect(p.input.fire).toBe(false);
    steps(sim, seconds(0.5));
    sim.drainEvents();
    steps(sim, seconds(1.5));
    expect(sim.drainEvents().some((e) => e.type === 'cast')).toBe(false);
  });
});
