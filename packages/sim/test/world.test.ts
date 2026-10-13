import { describe, expect, it } from 'vitest';
import { TILE } from '../src/constants.js';
import {
  collide,
  damageProp,
  isFree,
  propsInCircle,
  terrainRaw,
  WALL,
  FLOOR,
  chunkAt,
} from '../src/world.js';
import { player, quietSim, steps } from './helpers.js';
import type { Prop } from '../src/world.js';

describe('world', () => {
  it('generates the same terrain from the same seed, different from another', () => {
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    for (let ty = -60; ty < 60; ty += 3) {
      for (let tx = -60; tx < 60; tx += 3) {
        a.push(terrainRaw(5, tx, ty));
        b.push(terrainRaw(5, tx, ty));
        c.push(terrainRaw(6, tx, ty));
      }
    }
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.filter((t) => t === WALL).length).toBeGreaterThan(10);
  });

  it('keeps a clear starting area', () => {
    for (let ty = -8; ty <= 8; ty++)
      for (let tx = -8; tx <= 8; tx++) {
        if (Math.hypot(tx, ty) < 9) expect(terrainRaw(123, tx, ty)).toBe(FLOOR);
      }
    const sim = quietSim(4);
    for (const p of sim.state.players) expect(isFree(sim.ctx, p.x, p.y, p.r)).toBe(true);
  });

  it('pushes bodies out of walls', () => {
    const sim = quietSim();
    // A wall tile with open floor on its left; a body overlapping its left edge.
    const seed = sim.state.world.seed;
    const free = (tx: number, ty: number) => terrainRaw(seed, tx, ty) === FLOOR;
    let wall: [number, number] | null = null;
    for (let tx = 10; tx < 200 && !wall; tx++)
      for (let ty = -50; ty < 50 && !wall; ty++) {
        if (
          terrainRaw(seed, tx, ty) === WALL &&
          free(tx - 1, ty) &&
          free(tx - 1, ty - 1) &&
          free(tx - 1, ty + 1)
        )
          wall = [tx, ty];
      }
    expect(wall).not.toBeNull();
    const body = { x: wall![0] * TILE + 4, y: wall![1] * TILE + TILE / 2, r: 12 };
    expect(collide(sim.ctx, body)).toBe(true);
    expect(body.x).toBeCloseTo(wall![0] * TILE - 12);
    const tile = (v: number) => Math.floor(v / TILE);
    expect(terrainRaw(sim.state.world.seed, tile(body.x), tile(body.y))).not.toBe(WALL);
  });

  it('broken props stay broken and damage survives chunk regeneration', () => {
    const sim = quietSim();
    const { ctx } = sim;
    const findRock = (): Prop => {
      for (let cx = -4; cx <= 4; cx++) {
        for (let cy = -4; cy <= 4; cy++) {
          const r = chunkAt(ctx.d, ctx.s.world, ctx.chunks, cx, cy).props.find(
            (p) => p.type === 'rock',
          );
          if (r) return r;
        }
      }
      throw new Error('no rock near the start');
    };
    const rock = findRock();
    damageProp(ctx, rock, 10);
    expect(ctx.s.world.propHp[rock.key]).toBe(rock.maxHp - 10);
    // Drop the cache: the prop comes back with its damage (state), not at full HP.
    ctx.chunks.chunks.clear();
    const again = propsInCircle(ctx, rock.x, rock.y, 1).find((p) => p.key === rock.key)!;
    expect(again).toBeDefined();
    damageProp(ctx, again, 1000);
    expect(ctx.s.world.broken[rock.key]).toBe(1);
    ctx.chunks.chunks.clear();
    expect(propsInCircle(ctx, rock.x, rock.y, 1).some((p) => p.key === rock.key)).toBe(false);
  });

  it('liquids: water slows (not Water types), lava hurts (not Fire types)', () => {
    const sim = quietSim();
    const { d } = sim.ctx;
    const lava = d.game.biomes.runBiomes.findIndex((b) => b.liquid === 'lava');
    expect(d.liquidEffect(0, ['electric']).slow).toBe(0.6);
    expect(d.liquidEffect(0, ['water'])).toEqual({});
    expect(lava).toBeGreaterThan(0);
    expect(d.liquidEffect(lava, ['electric']).damage).toBeGreaterThan(0);
    expect(d.liquidEffect(lava, ['fire'])).toEqual({});
    expect(d.liquidHurts(lava)).toBe(true);
    const p = player(sim);
    p.inLiquid = true;
    sim.setInput(p.id, { moveX: 1, moveY: 0 });
    steps(sim, 1);
  });
});
