// A read-only view of the map for clients: terrain, props, liquids and the movement step, over a
// world state the client keeps in sync from snapshots (`world.broken`, `world.arena`, …). The
// renderer draws props from it and client-side prediction moves the player's own Pokémon with the
// same collision code as the sim (`moveBody`), so prediction and the server agree.
import { CHUNK_TILES as N } from './constants.js';
import type { Ctx } from './ctx.js';
import { simData } from './data.js';
import { makeRand, seedRng } from './rng.js';
import { liquidSpeedMult, moveBody, type MovingBody } from './players.js';
import type { ArenaGeometry, SimState, WorldState } from './state.js';
import {
  createChunkCache,
  isLiquid,
  liquidKind,
  propHp,
  propsInRect,
  terrainAt,
  type Prop,
  type Terrain,
} from './world.js';

const chunkKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

export class WorldView {
  readonly world: WorldState;
  private readonly ctx: Ctx;

  constructor(seed: number) {
    this.world = {
      seed,
      biome: 0,
      broken: {},
      propHp: {},
      arena: null,
      altarsUsed: {},
      springs: {},
      chests: {},
    };
    // World queries only read `s.world` (and the static data): the rest of the state is unused.
    const s = { world: this.world } as SimState;
    this.ctx = {
      s,
      d: simData(),
      rand: makeRand(seedRng(seed)),
      events: [],
      chunks: createChunkCache(seed),
      grid: new Map(),
      enemyById: new Map(),
      paths: new Map(),
    };
  }

  /** The biome index (the run's liquid changes with it). */
  setBiome(biome: number): void {
    this.world.biome = biome;
  }

  /** The arena geometry while the team is in one (terrain and props change): null on the map. */
  setArena(arena: ArenaGeometry | null): void {
    const a = this.world.arena;
    const same =
      a === arena || (!!a && !!arena && a.tx === arena.tx && a.ty === arena.ty && a.r === arena.r);
    if (same) return;
    this.world.arena = arena
      ? {
          tx: arena.tx,
          ty: arena.ty,
          r: arena.r,
          type: arena.type,
          pillars: arena.pillars,
          pools: arena.pools,
        }
      : null;
    this.ctx.chunks.chunks.clear();
  }

  /**
   * The world's keyed records as the snapshot has them. Chunks holding newly broken props are
   * regenerated (props are placed when a chunk is built).
   */
  setRecords(records: Readonly<Record<string, Readonly<Record<string, number>>>>): void {
    const broken = records.broken ?? {};
    for (const key of Object.keys(broken)) {
      if (this.world.broken[key]) continue;
      this.world.broken[key] = 1;
      this.forgetTile(key);
    }
    for (const key of Object.keys(this.world.broken)) {
      if (broken[key]) continue;
      delete this.world.broken[key];
      this.forgetTile(key);
    }
    this.world.propHp = { ...(records.propHp ?? {}) };
    this.world.altarsUsed = Object.fromEntries(
      Object.keys(records.altarsUsed ?? {}).map((k) => [k, 1 as const]),
    );
    this.world.springs = { ...(records.springs ?? {}) };
    this.world.chests = { ...(records.chests ?? {}) };
  }

  private forgetTile(key: string): void {
    const [tx, ty] = key.split(',').map(Number) as [number, number];
    this.ctx.chunks.chunks.delete(chunkKey(Math.floor(tx / N), Math.floor(ty / N)));
  }

  terrain(tx: number, ty: number): Terrain {
    return terrainAt(this.ctx, tx, ty);
  }

  /** Live props (not broken) with their centre in the rectangle. */
  propsInRect(x0: number, y0: number, x1: number, y1: number): Prop[] {
    return propsInRect(this.ctx, x0, y0, x1, y1).filter((p) => !this.world.broken[p.key]);
  }

  propHp(p: Prop): number {
    return propHp(this.ctx, p);
  }

  /** The liquid on the map now (`water`, `lava`, …): the biome's, or the arena's. */
  liquidKind(): string {
    return liquidKind(this.ctx);
  }

  liquidHurts(): boolean {
    return this.ctx.d.liquidHurts(this.liquidKind());
  }

  isLiquid(x: number, y: number): boolean {
    return isLiquid(this.ctx, x, y);
  }

  /**
   * One tick of the sim's player movement for `body`. `speed`: the player's speed before liquids
   * (`moveSpeedOf`, sent in the viewer's snapshot); the liquid's slow is applied here.
   */
  move(body: MovingBody, moveX: number, moveY: number, speed: number): void {
    moveBody(this.ctx, body, moveX, moveY, speed * liquidSpeedMult(this.ctx, body));
  }
}
