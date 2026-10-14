// The simulation: createSim() builds a run for 1–4 players; step() advances it one fixed tick.
// The same code runs on the server (co-op rooms) and in a Web Worker (solo).
import { offerBonds } from './bonds.js';
import { BIOME_SECONDS, DT, TICK_HZ } from './constants.js';
import {
  autoResolveFor,
  findChoice,
  rerollChoice,
  resolveChoice,
  tickChoices,
  type ChoiceResult,
} from './choices.js';
import { resolveCollisions, tickCombat, updateFields } from './combat.js';
import { emit, playerById, presentPlayers, type Ctx } from './ctx.js';
import { simData } from './data.js';
import { rebuildGrid, updateEnemies } from './enemies.js';
import type { SimEvent } from './events.js';
import { updateHazards } from './hazards.js';
import { updateInteract } from './interact.js';
import { maybeLevelUp } from './levelup.js';
import { cycleSlot, setActive } from './moves.js';
import { updatePaths, type PathField } from './pathing.js';
import { updatePickups } from './pickups.js';
import {
  clampAimInput,
  clampMoveInput,
  createPlayer,
  reviveTick,
  trackVelocities,
  updatePlayer,
  type PlayerConfig,
} from './players.js';
import { clearOrbs, updateProjectiles } from './projectiles.js';
import { makeRand, seedRng } from './rng.js';
import { openRift, startArena, updateRift } from './rift.js';
import { spawnThief, startEvent, updateRunEvents } from './runevents.js';
import { rollRoster, updateSpawner } from './spawner.js';
import { newTeam } from './team.js';
import { startWeather, updateWeather } from './weather.js';
import { createChunkCache } from './world.js';
import type { PlayerId, PlayerState, RunEventId, SimState } from './state.js';
import type { PokemonType, WeatherId } from '@pokesurvivor/data';
import { stateHash } from './hash.js';
import { playerRunSummary, runSummary, type OwnsPokemon, type RunSummary } from './summary.js';
import type { RunSummary as ProtocolRunSummary } from '@pokesurvivor/protocol';

export interface SimConfig {
  seed: number;
  /** 1–4 players, in join order. */
  players: readonly PlayerConfig[];
  /**
   * Seconds before a pending choice (level-up cards, item swap) auto-resolves to its first option.
   * null: never (solo, where the game simply waits). Default 30.
   */
  choiceTimeoutSeconds?: number | null;
  /** Debug and tests only. */
  debug?: { invulnerable?: boolean; noSpawns?: boolean };
}

export interface MoveInput {
  /** Movement direction (keyboard axes or a joystick vector); clamped to length 1. */
  moveX: number;
  moveY: number;
  /** Switch to this move slot (0-based) on the next tick. Send it once per key press. */
  slot?: number | null;
  /**
   * Manual aim (radians): aimed attacks go this way instead of at the auto target. Absent or
   * null: auto-aim. Persists like movement, so every call sets it.
   */
  aim?: number | null;
}

export type Intent =
  | { type: 'pickCard'; choiceId: number; cardId: string }
  /** Item swap: `itemId` is the item to hold (the current one or the one found). */
  | { type: 'pickItem'; choiceId: number; itemId: string }
  | { type: 'reroll'; choiceId: number }
  /**
   * Bond: the loose moves to fuse, from the choice's `loose`: two for `pair`, one for `add` (it
   * joins the choice's `group`).
   */
  | { type: 'pickBond'; choiceId: number; moves: string[] }
  /** Next / previous move slot (Q / E). */
  | { type: 'cycleSlot'; dir: 1 | -1 };

/** Seconds everyone must have been down before the run ends (to see the last one faint). */
const ALL_DOWN_SOLO = 1.3;
const ALL_DOWN_GROUP = 1.6;

export const MAX_PLAYERS = 4;

export class Sim {
  readonly state: SimState;
  /** Internal: the systems' context (for tests and tools; not part of the API). */
  readonly ctx: Ctx;

  /** Use `createSim` or `restoreSim`. `init` runs once with the context (new runs). */
  constructor(state: SimState, init?: (ctx: Ctx) => void) {
    this.state = state;
    this.ctx = {
      s: state,
      d: simData(),
      rand: makeRand(state.rng),
      events: [],
      chunks: createChunkCache(state.world.seed),
      grid: new Map(),
      enemyById: new Map(),
      paths: new Map<PlayerId, PathField>(),
    };
    init?.(this.ctx);
    rebuildGrid(this.ctx);
  }

  /** Movement persists until changed; `slot` is a one-shot request. */
  setInput(playerId: PlayerId, input: MoveInput): void {
    const p = playerById(this.state, playerId);
    if (!p || p.left) return;
    p.input.moveX = clampMoveInput(input.moveX);
    p.input.moveY = clampMoveInput(input.moveY);
    if (input.slot != null && Number.isInteger(input.slot)) p.input.slot = input.slot;
    p.input.aim = clampAimInput(input.aim);
  }

  submitIntent(playerId: PlayerId, intent: Intent): ChoiceResult {
    const p = playerById(this.state, playerId);
    if (!p || p.left) return { ok: false, error: 'unknown player' };
    switch (intent.type) {
      case 'pickCard': {
        const c = findChoice(this.ctx, playerId, intent.choiceId);
        if (!c || c.kind !== 'level-up') return { ok: false, error: 'no such level-up choice' };
        return resolveChoice(this.ctx, c, intent.cardId);
      }
      case 'pickItem': {
        const c = findChoice(this.ctx, playerId, intent.choiceId);
        if (!c || c.kind !== 'item') return { ok: false, error: 'no such item choice' };
        return resolveChoice(this.ctx, c, intent.itemId);
      }
      case 'pickBond': {
        const c = findChoice(this.ctx, playerId, intent.choiceId);
        if (!c || c.kind !== 'bond') return { ok: false, error: 'no such bond choice' };
        if (!Array.isArray(intent.moves) || !intent.moves.every((m) => typeof m === 'string'))
          return { ok: false, error: 'bad moves' };
        return resolveChoice(this.ctx, c, intent.moves);
      }
      case 'reroll': {
        const c = findChoice(this.ctx, playerId, intent.choiceId);
        if (!c) return { ok: false, error: 'no such choice' };
        return rerollChoice(this.ctx, c);
      }
      case 'cycleSlot':
        if (intent.dir !== 1 && intent.dir !== -1) return { ok: false, error: 'bad direction' };
        if (this.paused || p.dead) return { ok: false, error: 'not now' };
        cycleSlot(this.ctx, p, intent.dir);
        return { ok: true };
      default:
        // Intents arrive from the network: an unknown type is rejected, never thrown on.
        return { ok: false, error: 'unknown intent' };
    }
  }

  /** A player dropped (true → false) or came back. While disconnected they're idle and invulnerable. */
  setConnected(playerId: PlayerId, connected: boolean): void {
    const p = playerById(this.state, playerId);
    if (!p || p.left || p.connected === connected) return;
    p.connected = connected;
    if (!connected) {
      p.input.moveX = 0;
      p.input.moveY = 0;
      clearOrbs(this.ctx, p.id);
      autoResolveFor(this.ctx, p.id);
    }
  }

  /** A player left for good (or their reconnect grace ran out). They stay in the summary. */
  removePlayer(playerId: PlayerId): void {
    const p = playerById(this.state, playerId);
    if (!p || p.left) return;
    p.left = true;
    p.connected = false;
    clearOrbs(this.ctx, p.id);
    autoResolveFor(this.ctx, p.id);
    delete this.state.pathOrigins[p.id];
    this.ctx.paths.delete(p.id);
    emit(this.ctx, { type: 'say', key: 'hud.leftTheGame', params: { 0: p.id }, seconds: 3 });
    if (!presentPlayers(this.state).length) this.end('everyone-left');
  }

  /** Paused while any choice is pending (for everyone). */
  get paused(): boolean {
    return this.state.pendingChoices.length > 0;
  }

  get ended(): boolean {
    return this.state.ended !== null;
  }

  /** Events since the last call (cosmetic; see events.ts). */
  drainEvents(): SimEvent[] {
    const out = this.ctx.events;
    this.ctx.events = [];
    return out;
  }

  /** Deterministic hash of the whole state (same seed + same inputs → same hash). */
  hash(): string {
    return stateHash(this.state);
  }

  /** `owns`: whether a player already owns a Pokémon (the 150-coin rescue consolation). */
  summary(owns?: OwnsPokemon): RunSummary {
    return runSummary(this.ctx, owns);
  }

  /**
   * One player's result in the protocol shape (`POST /api/runs`, `recordCoopRun`). `owns`: whether
   * this player already owns a Pokémon (rescued ones they own give coins instead).
   */
  runSummaryFor(playerId: PlayerId, owns?: (dex: number) => boolean): ProtocolRunSummary {
    const byPlayer: OwnsPokemon | undefined = owns && ((id, dex) => id === playerId && owns(dex));
    return playerRunSummary(runSummary(this.ctx, byPlayer), playerId);
  }

  /** Debug: the next `n` spawns are shiny. */
  debugForceShiny(n: number): void {
    this.state.spawner.forceShiny = n;
  }

  /** Debug: open a rift near a player now. */
  debugOpenRift(): void {
    openRift(this.ctx);
  }

  /** Debug: take the team to a legendary's arena now (optionally of one type). */
  debugStartArena(type?: PokemonType): void {
    startArena(this.ctx, type);
  }

  /** Debug: start an event now (`thief`: a treasure thief). */
  debugStartEvent(id: RunEventId | 'thief'): void {
    if (id === 'thief') spawnThief(this.ctx);
    else if (!this.state.events.current) startEvent(this.ctx, id);
  }

  /** Debug: start a weather now. */
  debugStartWeather(kind: WeatherId, seconds = 60): void {
    startWeather(this.ctx, kind, seconds);
  }

  /** Advances one tick (1 / TICK_HZ s). */
  step(): void {
    const { state: s, ctx } = this;
    if (s.ended) return;
    s.tick++;
    tickChoices(ctx);
    if (s.pendingChoices.length) {
      for (const p of s.players) p.input.slot = null;
      return;
    }
    s.time += DT;

    // (The biome waits while the team is in a rift arena.)
    const biome = Math.floor(s.time / BIOME_SECONDS);
    if (biome !== s.world.biome && !s.arena) {
      s.world.biome = biome;
      const list = ctx.d.game.biomes.runBiomes;
      const b = list[biome % list.length];
      emit(ctx, { type: 'biome', index: biome, biomeId: b?.id ?? '' });
    }

    for (const p of s.players) {
      if (p.input.slot === null) continue;
      if (!p.dead && p.connected) setActive(ctx, p, p.input.slot);
      p.input.slot = null;
    }

    for (const p of s.players) updatePlayer(ctx, p);
    if (presentPlayers(s).length > 1) for (const p of s.players) reviveTick(ctx, p);
    updatePaths(ctx);
    updateSpawner(ctx);
    trackVelocities(ctx);
    updateEnemies(ctx);
    rebuildGrid(ctx);
    tickCombat(ctx);
    updateProjectiles(ctx);
    resolveCollisions(ctx);
    updateFields(ctx);
    updatePickups(ctx);
    updateHazards(ctx);
    updateInteract(ctx);
    updateRift(ctx);
    updateRunEvents(ctx);
    updateWeather(ctx);
    maybeLevelUp(ctx);
    offerBonds(ctx);
    this.checkAllDown();
  }

  private checkAllDown(): void {
    const s = this.state;
    const players = presentPlayers(s);
    // In a rift arena, going down only sends you back (rift.ts).
    if (!players.length || !players.every((p) => p.dead) || s.arena) {
      s.allDownT = 0;
      return;
    }
    s.allDownT += DT;
    if (s.allDownT > (players.length > 1 ? ALL_DOWN_GROUP : ALL_DOWN_SOLO)) this.end('all-down');
  }

  private end(reason: 'all-down' | 'everyone-left'): void {
    const s = this.state;
    if (s.ended) return;
    s.ended = { reason, tick: s.tick, time: s.time };
    const group = s.players.length > 1;
    for (const p of s.players) {
      emit(this.ctx, {
        type: 'progress',
        event: 'run-end',
        playerId: p.id,
        data: { time: s.time, level: s.team.level, coins: s.team.coins, types: p.types, group },
      });
    }
    emit(this.ctx, { type: 'run-ended', reason });
  }
}

export function createSim(config: SimConfig): Sim {
  const n = config.players.length;
  if (n < 1 || n > MAX_PLAYERS) throw new Error(`a run needs 1–${MAX_PLAYERS} players`);
  if (new Set(config.players.map((p) => p.id)).size !== n) throw new Error('duplicate player id');
  const timeout = config.choiceTimeoutSeconds === undefined ? 30 : config.choiceTimeoutSeconds;
  const seed = Math.floor(Math.abs(config.seed)) % 2 ** 31 || 1;
  const data = simData().game;
  const state: SimState = {
    tick: 0,
    time: 0,
    rng: seedRng(seed),
    nextId: 1,
    world: {
      seed,
      biome: 0,
      broken: {},
      propHp: {},
      arena: null,
      altarsUsed: {},
      springs: {},
      chests: {},
    },
    players: [],
    team: newTeam(),
    enemies: [],
    projectiles: [],
    fields: [],
    pickups: [],
    hazards: [],
    spawner: { acc: 0, bossIndex: 0, surgeT: 32, forceShiny: 0 },
    roster: { tiers: [], bosses: [] },
    pendingChoices: [],
    nextChoiceId: 1,
    pendingLevels: 0,
    pathOrigins: {},
    pathTimer: 0,
    allDownT: 0,
    rift: { checkT: data.tuning.rift.checkEvery, misses: 0, opened: 0, open: null },
    arena: null,
    weather: { current: null, checkT: data.weather.checkEvery, chipT: 0 },
    events: { nextT: 0, current: null, last: null, thiefT: 0, thieves: 0, lost: null },
    ended: null,
    config: {
      choiceTimeoutTicks: timeout === null ? null : Math.max(1, Math.round(timeout * TICK_HZ)),
      invulnerable: !!config.debug?.invulnerable,
      noSpawns: !!config.debug?.noSpawns,
    },
  };
  const sim = new Sim(state, (ctx) => {
    state.roster = rollRoster(ctx);
    state.players = config.players.map((cfg, i): PlayerState => createPlayer(ctx, cfg, i, n));
    const ev = data.tuning.events;
    state.events.nextT = ctx.rand.range(ev.every[0], ev.every[1]);
    state.events.thiefT = ctx.rand.range(ev.thiefFirst[0], ev.thiefFirst[1]);
  });
  sim.drainEvents();
  return sim;
}

/** Rebuilds a Sim from a state snapshot (a deep copy of `sim.state`, e.g. through JSON). */
export function restoreSim(state: SimState): Sim {
  // Solo saves from before recipient cooldowns were introduced remain resumable. Migrate only
  // those enemies: current snapshots must restore byte-for-byte for deterministic replay.
  const tuning = simData().game.tuning.enemyShields;
  for (const e of [...state.enemies, ...(state.arena?.stash ?? [])]) {
    if (e.shieldCd !== undefined) continue;
    e.shieldCd = e.shield > 0 ? tuning.reapplyCooldown : 0;
    e.shield =
      !tuning.affectsBosses && (e.boss || e.legend)
        ? 0
        : Math.min(e.shield, e.maxHp * tuning.maxHpFraction);
    e.shieldT = e.shield > 0 ? Math.min(e.shieldT, tuning.duration) : 0;
    if (e.behavior === 'shielder') e.skillCd = Math.min(e.skillCd, tuning.cooldown);
  }
  return new Sim(state);
}
