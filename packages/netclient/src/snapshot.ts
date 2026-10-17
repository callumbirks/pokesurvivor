// Snapshots: what one client sees of the sim, as delta-compressed integer tables plus a small
// JSON part. `SnapshotEncoder` (server: one per client and game; the future solo adapter can use
// it too) projects the sim state for one viewer; `SnapshotDecoder` (client) rebuilds the view.
//
// Interest management: enemies, projectiles, pickups, fields and hazards are sent only near the
// viewer's Pokémon, or the player it spectates (`focusId`; enter within `radius`, leave beyond
// `radius + hysteresis`); players and the team always. Strings (pickup kinds, move ids, types, …)
// go through a per-connection string table, so new kinds the sim adds (2b) need no wire changes.
// Pending choices are state: every snapshot lists all of them (the viewer's own in full).
import {
  BinaryReader,
  BinaryWriter,
  FrameKind,
  JsonReader,
  JsonWriter,
  TableDecoder,
  TableEncoder,
  readFrame,
  writeFrame,
  type Reader,
} from '@pokesurvivor/protocol';
import { TICK_HZ, isAttacking, playerMoveSpeed, playerStats } from '@pokesurvivor/sim';
import type {
  ArenaState,
  LostPokemonState,
  EnemyState,
  FieldState,
  HazardState,
  PendingChoice,
  PlayerState,
  ProjectileState,
  RunEnd,
  SimEvent,
  SimState,
} from '@pokesurvivor/sim';
import { EventDecoder, EventEncoder, filterEvents, type Shape } from './events.js';

/** Legacy sent enemies within 950 units of each player. */
export const INTEREST_RADIUS = 950;
const HYSTERESIS = 150;

// Quantization: positions in 1/2 unit (players 1/8), angles in 1/64 rad.
const POS = 2;
const PLAYER_POS = 8;
const ANGLE = 64;

const q = (v: number, scale: number) => Math.round(v * scale);
const flags = (...bits: boolean[]) => bits.reduce((acc, b, i) => acc + (b ? 2 ** i : 0), 0);
const bit = (v: number, i: number) => Math.floor(v / 2 ** i) % 2 === 1;

// ------------------------------------------------------------------ view types (decoded)

export interface NetPlayer {
  id: string;
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  moveAngle: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  connected: boolean;
  left: boolean;
  walking: boolean;
  invulnerable: boolean;
  inLiquid: boolean;
  /** Stuck in a trap (half speed). */
  trapped: boolean;
  /** Attacking (casting, until just after the next cast): it faces its aim (`facingOf`). */
  attacking: boolean;
  /** Revive progress while down, in seconds. */
  reviveT: number;
  active: number;
}

export interface NetEnemy {
  id: number;
  dex: number;
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  face: number;
  boss: boolean;
  shiny: boolean;
  golden: boolean;
  legend: boolean;
  /** A legendary in the wild (also `boss`). */
  wildLegend: boolean;
  flying: boolean;
  burning: boolean;
  poisoned: boolean;
  slowed: boolean;
  shielded: boolean;
  /** Remaining shield HP, on the same scale as hp/maxHp. */
  shield: number;
  fury: boolean;
  dead: boolean;
  phase: string;
  scale: number;
  height: number;
  /** 0–1 through a jump, or null. */
  jump: number | null;
  /** `chase`, `shooter`, `healer`, `thief`, … (the HUD marks supports and thieves). */
  behavior: string;
}

export interface NetProjectile {
  id: number;
  x: number;
  y: number;
  r: number;
  /** Velocity direction. */
  angle: number;
  friendly: boolean;
  orb: boolean;
  returning: boolean;
  ownerIndex: number | null;
  type: string | null;
  moveId: string | null;
}

export interface NetPickup {
  id: number;
  kind: string;
  x: number;
  y: number;
  itemId: string | null;
}

export interface NetField {
  id: number;
  kind: string;
  x: number;
  y: number;
  r: number;
  type: string;
  ownerIndex: number;
  moveId: string;
  /** Mines: seconds left before armed (0: armed); meteors: seconds left to land. */
  arm: number;
  /**
   * 0–1 through its life (mines, turrets, trail pools). Meteors: through their fall, below 0
   * while a staggered one of a volley hasn't started falling yet.
   */
  progress: number;
}

export interface NetHazard {
  id: number;
  kind: string;
  x: number;
  y: number;
  r: number;
  angle: number;
  len: number;
  w: number;
  type: string;
  /** 0–1 through the warning. */
  progress: number;
  hit: boolean;
}

export interface NetTeam {
  level: number;
  xp: number;
  xpNext: number;
  kills: number;
  bosses: number;
  coins: number;
  tickets: number;
  tickets10: number;
  biome: number;
  shinies: number[];
}

/** What rarely changes about a player: sent when it changes. */
export interface PlayerDetail {
  moves: { id: string; level: number; evolved: boolean; kind: string; type: string }[];
  slots: string[][];
  maxSlots: number;
  item: string | null;
  bonds: number;
  rerollsLeft: number;
  types: string[];
  /** Pickup radius. */
  magnet: number;
  /** Altar power in effect. */
  power: { id: string; t: number } | null;
  /** Buff stacks: attack, speed, defense, regen. */
  buffs: [number, number, number, number];
}

/** What only the viewer gets about its own Pokémon, in every snapshot. */
export interface SelfState {
  /** Per move (in `PlayerDetail.moves` order): cooldown left, 0–1 of the full cooldown. */
  cooldowns: number[];
  /** Speed before liquids (`moveSpeedOf`): client-side prediction moves at this. */
  speed: number;
  /**
   * Momentum stacks (kill streak; tuning `momentum`), in 1/10 steps. Optional: added within
   * protocol 7, so older servers don't send it (read as 0).
   */
  momentum?: number;
}

/**
 * The viewer's stats panel (sim `playerStats`): attack, speed and max HP with their species base,
 * and the multipliers and amounts with none. Attack leaves out Momentum (`self.momentum`).
 */
export interface SelfStats {
  attackBase: number;
  attack: number;
  speedBase: number;
  speed: number;
  hpBase: number;
  maxHp: number;
  cooldown: number;
  /**
   * Damage reduction equivalent of the defence (1 − 1 / (1 + defence)): what clients before
   * defence became toughness show. Newer clients use `defense`.
   */
  damageReduction: number;
  /** Defence in effect (+% toughness, 1 = +100%). Optional: added within protocol 7. */
  defense?: number;
  regen: number;
  magnet: number;
  xp: number;
  crit: number;
}

/** Stats go out when they change, at most this often (ticks): a trap's slow can flicker them. */
const STATS_EVERY_TICKS = 15;

/** Who a pending choice waits for (every choice, anyone's). */
export interface ChoiceRef {
  id: number;
  playerId: string;
  kind: string;
  deadlineTick: number | null;
}

export interface Snapshot {
  seq: number;
  tick: number;
  /** Seconds played. */
  time: number;
  /** The last input `seq` the server applied for this client (for reconciliation). */
  ackSeq: number;
  /** A full snapshot (first one, or after a reconnect). */
  full: boolean;
  paused: boolean;
  ended: RunEnd | null;
  players: NetPlayer[];
  enemies: NetEnemy[];
  projectiles: NetProjectile[];
  pickups: NetPickup[];
  fields: NetField[];
  hazards: NetHazard[];
  team: NetTeam;
  /** This client's pending choices, in full (the sim's `PendingChoice`). */
  choices: PendingChoice[];
  /** Every pending choice (the game is paused while there are any). */
  waiting: ChoiceRef[];
  /** Events since the previous snapshot that concern this client. */
  events: SimEvent[];
  /** Latest details per player id. */
  details: Record<string, PlayerDetail>;
  /**
   * Every keyed record of `state.world` (tile key → number): `broken`, `propHp`, `altarsUsed`,
   * `springs`, `chests`, and any the sim adds. Sent as changes.
   */
  world: Record<string, Record<string, number>>;
  /** Rifts, the arena, weather and run events (`NetMisc`). */
  misc: NetMisc;
  /** The viewer's own cooldowns and speed (null if it isn't a player). */
  self: SelfState | null;
  /** The viewer's stats panel: the latest sent (null before the first). Optional for fixtures. */
  stats?: SelfStats | null;
}

/**
 * What the HUD and renderer need of the rift, the arena, the weather and run events. Timers are
 * whole seconds, so this changes about once a second; it's sent when it changes.
 */
export interface NetMisc {
  /** The rift waiting on the map. */
  rift: { x: number; y: number; ttl: number; t: number } | null;
  /** The arena while the team is in it (`terrainRaw` needs the geometry). */
  arena: (Omit<ArenaState, 'stash' | 'back' | 'endT' | 'downT' | 't'> & { t: number }) | null;
  weather: { kind: string; t: number; dur: number } | null;
  event: { id: string; t: number; dur: number | null; type: string | null } | null;
  /** The lost Pokémon (moves while following someone). */
  lost: Omit<LostPokemonState, 't' | 'hitCd' | 'joins'> | null;
  /** Back from a rift: whole seconds until the frozen map resumes (the 3-2-1). Absent: playing. */
  resume?: number;
}

// ------------------------------------------------------------------ tables

const T = { players: 0, enemies: 1, projectiles: 2, pickups: 3, fields: 4, hazards: 5, team: 6 };
const WIDTHS = [11, 14, 8, 4, 9, 10, 9];

/**
 * Header: seq, tick, time (ms), ackSeq, flags (full, paused), and the seq of the frame this one
 * is a delta against (0 for full frames): a client that missed a frame notices and resyncs.
 */
const enum H {
  seq,
  tick,
  timeMs,
  ackSeq,
  flags,
  baseSeq,
}

interface Extra {
  /** New entries of the string table: index → string. */
  strings?: Record<number, string>;
  choices: PendingChoice[];
  waiting: ChoiceRef[];
  /** New event shapes (the events themselves follow the JSON part, binary). */
  shapes?: Record<number, Shape>;
  details?: Record<string, PlayerDetail>;
  /** World record changes: record → key → value (null: removed). */
  world?: Record<string, Record<string, number | null>>;
  misc?: NetMisc;
  shinies?: number[];
  ended?: RunEnd | null;
  self?: SelfState;
  /** The viewer's stats panel, when it changed. Optional: added within protocol 7. */
  stats?: SelfStats;
}

export type SnapshotFormat = 'binary' | 'json';

export interface SnapshotEncoderOptions {
  viewerId: string;
  radius?: number;
  format?: SnapshotFormat;
}

/** Server side: projects the sim state for one viewer and encodes the changes since last time. */
export class SnapshotEncoder {
  private readonly tables = WIDTHS.map((w) => new TableEncoder(w));
  private strings = new Map<string, number>();
  private newStrings: Record<number, string> = {};
  private visible = new Set<number>();
  private details = new Map<string, string>();
  private world = new Map<string, Map<string, number>>();
  private misc = '';
  private shinies = '';
  private ended: string | null = null;
  private stats = '';
  private statsTick = -Infinity;
  private full = true;
  private lastSeq = 0;
  private readonly events = new EventEncoder((s) => this.str(s));
  readonly viewerId: string;
  readonly radius: number;
  readonly format: SnapshotFormat;
  /**
   * Spectating (the server sets it while the viewer is down): the player whose surroundings are
   * sent instead of the viewer's. Null, or a player who isn't in the state: the viewer. Only the
   * interest area moves; `self`, `stats`, choices and personal events stay the viewer's.
   */
  focusId: string | null = null;

  constructor(opts: SnapshotEncoderOptions) {
    this.viewerId = opts.viewerId;
    this.radius = opts.radius ?? INTEREST_RADIUS;
    this.format = opts.format ?? 'binary';
  }

  /** The next snapshot is full (the client lost its state: new connection or resume). */
  reset(): void {
    for (const t of this.tables) t.reset();
    this.strings.clear();
    this.newStrings = {};
    this.visible.clear();
    this.details.clear();
    this.world.clear();
    this.misc = '';
    this.shinies = '';
    this.ended = null;
    this.stats = '';
    this.statsTick = -Infinity;
    this.events.reset();
    this.full = true;
  }

  private str(s: string | null | undefined): number {
    if (s == null) return 0;
    let i = this.strings.get(s);
    if (i === undefined) {
      i = this.strings.size + 1;
      this.strings.set(s, i);
      this.newStrings[i] = s;
    }
    return i;
  }

  /**
   * `opts.paused`: mark the frame paused even without a pending choice (the server holds a
   * restored game until its players are back): clients stop predicting and send no movement.
   */
  encode(
    s: SimState,
    events: readonly SimEvent[],
    seq: number,
    ackSeq: number,
    opts: { paused?: boolean } = {},
  ): Uint8Array | string {
    const viewer = s.players.find((p) => p.id === this.viewerId);
    const focus = (this.focusId !== null && s.players.find((p) => p.id === this.focusId)) || viewer;
    const cx = focus?.x ?? 0;
    const cy = focus?.y ?? 0;
    const enter = this.radius ** 2;
    const leave = (this.radius + HYSTERESIS) ** 2;
    const nextVisible = new Set<number>();
    const near = (id: number, x: number, y: number) => {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const ok = d2 <= enter || (d2 <= leave && this.visible.has(id));
      if (ok) nextVisible.add(id);
      return ok;
    };
    const indexOf = new Map(s.players.map((p) => [p.id, p.index]));
    const owner = (id: string | null) => (id === null ? 0 : (indexOf.get(id) ?? -1) + 1);

    const rows = WIDTHS.map(() => new Map<number, number[]>());
    for (const p of s.players) rows[T.players]!.set(p.index, playerRow(p, s.time));
    for (const e of s.enemies)
      if (near(e.id, e.x, e.y)) rows[T.enemies]!.set(e.id, this.enemyRow(e));
    for (const pr of s.projectiles)
      if (near(pr.id, pr.x, pr.y)) rows[T.projectiles]!.set(pr.id, this.projectileRow(pr, owner));
    for (const k of s.pickups)
      if (near(k.id, k.x, k.y))
        rows[T.pickups]!.set(k.id, [
          this.str(k.kind),
          q(k.x, POS),
          q(k.y, POS),
          this.str(k.itemId),
        ]);
    for (const f of s.fields)
      if (near(f.id, f.x, f.y)) rows[T.fields]!.set(f.id, this.fieldRow(f, owner));
    for (const h of s.hazards)
      if (near(h.id, h.x, h.y)) rows[T.hazards]!.set(h.id, this.hazardRow(h));
    const t = s.team;
    rows[T.team]!.set(0, [
      t.level,
      Math.floor(t.xp),
      t.xpNext,
      t.kills,
      t.bosses,
      t.coins,
      t.tickets,
      t.tickets10,
      s.world.biome,
    ]);

    const extra: Extra = {
      choices: s.pendingChoices.filter((c) => c.playerId === this.viewerId),
      waiting: s.pendingChoices.map(choiceRef),
    };
    if (viewer) {
      extra.self = selfState(s, viewer);
      this.addStats(s, viewer, extra);
    }
    const relevant = filterEvents(events, {
      viewerId: this.viewerId,
      x: cx,
      y: cy,
      radius: this.radius + HYSTERESIS,
      visible: (id) => nextVisible.has(id) || this.visible.has(id),
    });
    this.visible = nextVisible;
    // Events are written after the JSON part, but their new strings and shapes must be in it.
    const eventWriter = this.format === 'binary' ? new BinaryWriter() : new JsonWriter();
    extra.shapes = this.events.write(eventWriter, relevant);
    this.addDetails(s, extra);
    this.addWorld(s, extra);
    const misc = miscOf(s);
    const miscJson = JSON.stringify(misc);
    if (miscJson !== this.misc) {
      this.misc = miscJson;
      extra.misc = misc;
    }
    const shinies = JSON.stringify(t.shinies);
    if (shinies !== this.shinies) {
      this.shinies = shinies;
      extra.shinies = [...t.shinies];
    }
    const ended = JSON.stringify(s.ended);
    if (ended !== this.ended) {
      this.ended = ended;
      extra.ended = s.ended;
    }
    if (Object.keys(this.newStrings).length) extra.strings = this.newStrings;
    this.newStrings = {};

    const header = [
      seq,
      s.tick,
      Math.round(s.time * 1000),
      ackSeq,
      flags(this.full, opts.paused === true || s.pendingChoices.length > 0 || s.resumeTicks > 0),
      this.full ? 0 : this.lastSeq,
    ];
    this.full = false;
    this.lastSeq = seq;
    const w = this.format === 'binary' ? new BinaryWriter() : new JsonWriter();
    w.uint(FrameKind.snapshot);
    writeFrame(
      w,
      header,
      this.tables.map((encoder, i) => ({ encoder, rows: rows[i]! })),
      JSON.stringify(extra),
    );
    if (w instanceof BinaryWriter) {
      const bytes = (eventWriter as BinaryWriter).finish();
      const out = w.finish();
      const all = new Uint8Array(out.length + bytes.length);
      all.set(out);
      all.set(bytes, out.length);
      return all;
    }
    const values = w.values.concat((eventWriter as JsonWriter).values);
    return JSON.stringify(values);
  }

  private enemyRow(e: EnemyState): number[] {
    return [
      e.dex,
      q(e.x, POS),
      q(e.y, POS),
      Math.round(e.r),
      Math.ceil(Math.max(0, e.hp)),
      Math.round(e.maxHp),
      q(e.face, ANGLE),
      flags(
        e.boss,
        e.shiny,
        e.golden,
        e.legend,
        e.flying,
        e.burnT > 0,
        e.poisonT > 0,
        e.slowT > 0,
        e.shield > 0,
        !!e.ai?.fury,
        e.jump !== null,
        e.dead,
        e.wildLegend,
      ),
      this.str(e.phase),
      q(e.scale, 100),
      Math.round(e.height),
      e.jump ? Math.round((100 * e.jump.t) / (e.jump.dur || 1)) : 0,
      this.str(e.behavior),
      Math.ceil(Math.max(0, e.shield)),
    ];
  }

  private projectileRow(p: ProjectileState, owner: (id: string | null) => number): number[] {
    return [
      q(p.x, POS),
      q(p.y, POS),
      Math.round(p.r),
      q(Math.atan2(p.vy, p.vx), ANGLE),
      flags(p.friendly, p.orb, p.back),
      owner(p.ownerId),
      this.str(p.type),
      this.str(p.moveId),
    ];
  }

  private fieldRow(f: FieldState, owner: (id: string | null) => number): number[] {
    return [
      this.str(f.kind),
      q(f.x, POS),
      q(f.y, POS),
      Math.round(f.r),
      this.str(f.type),
      owner(f.ownerId),
      // In the sim, `arm` is a duration (mines: arming delay; meteors: fall time) and `t`
      // counts up from the cast (meteors of a volley start below 0, staggered).
      q(Math.max(0, f.arm - f.t), 10),
      fieldProgress(f),
      this.str(f.moveId),
    ];
  }

  private hazardRow(h: HazardState): number[] {
    return [
      this.str(h.kind),
      q(h.x, POS),
      q(h.y, POS),
      Math.round(h.r),
      q(h.angle, ANGLE),
      Math.round(h.len),
      Math.round(h.w),
      this.str(h.type),
      h.delay > 0 ? Math.round((100 * Math.min(h.t, h.delay)) / h.delay) : 100,
      h.hit ? 1 : 0,
    ];
  }

  private addStats(s: SimState, p: PlayerState, extra: Extra): void {
    if (s.tick - this.statsTick < STATS_EVERY_TICKS) return;
    const stats = selfStats(s, p);
    const json = JSON.stringify(stats);
    if (json === this.stats) return;
    this.stats = json;
    this.statsTick = s.tick;
    extra.stats = stats;
  }

  private addDetails(s: SimState, extra: Extra): void {
    for (const p of s.players) {
      const detail = playerDetail(p);
      const json = JSON.stringify(detail);
      if (this.details.get(p.id) === json) continue;
      this.details.set(p.id, json);
      (extra.details ??= {})[p.id] = detail;
    }
  }

  /** Diffs every keyed numeric record of `state.world` against what this client has. */
  private addWorld(s: SimState, extra: Extra): void {
    for (const [name, value] of Object.entries(s.world)) {
      if (!isNumberRecord(value)) continue;
      let sent = this.world.get(name);
      if (!sent) this.world.set(name, (sent = new Map<string, number>()));
      const changes: Record<string, number | null> = {};
      let changed = false;
      for (const [key, v] of Object.entries(value)) {
        const rounded = Math.round(v * 100) / 100;
        if (sent.get(key) === rounded) continue;
        sent.set(key, rounded);
        changes[key] = rounded;
        changed = true;
      }
      if (sent.size > Object.keys(value).length || changed) {
        for (const key of sent.keys()) {
          if (key in value) continue;
          sent.delete(key);
          changes[key] = null;
          changed = true;
        }
      }
      if (changed) (extra.world ??= {})[name] = changes;
    }
  }
}

/** A field's `progress`, in hundredths (see `NetField.progress`). */
function fieldProgress(f: FieldState): number {
  if (f.kind === 'meteor')
    return f.arm > 0 ? Math.round((100 * Math.min(f.t, f.arm)) / f.arm) : 100;
  return f.life > 0 ? Math.round((100 * f.t) / f.life) : 0;
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const x of Object.values(v)) if (typeof x !== 'number') return false;
  return true;
}

function miscOf(s: SimState): NetMisc {
  const whole = (x: number) => Math.floor(x);
  const open = s.rift?.open;
  const arena = s.arena;
  const weather = s.weather?.current;
  const event = s.events?.current;
  const lost = s.events?.lost;
  return {
    rift: open
      ? { x: Math.round(open.x), y: Math.round(open.y), ttl: whole(open.ttl), t: whole(open.t) }
      : null,
    arena: arena
      ? {
          tx: arena.tx,
          ty: arena.ty,
          r: arena.r,
          type: arena.type,
          pillars: arena.pillars,
          pools: arena.pools,
          dex: arena.dex,
          shiny: arena.shiny,
          x: arena.x,
          y: arena.y,
          phase: arena.phase,
          bossId: arena.bossId,
          t: whole(arena.t),
        }
      : null,
    weather: weather ? { kind: weather.kind, t: whole(weather.t), dur: weather.dur } : null,
    event: event ? { id: event.id, t: whole(event.t), dur: event.dur, type: event.type } : null,
    lost: lost
      ? {
          dex: lost.dex,
          x: Math.round(lost.x),
          y: Math.round(lost.y),
          r: lost.r,
          hp: Math.ceil(lost.hp),
          maxHp: lost.maxHp,
          phase: lost.phase,
          follow: lost.follow,
          moving: lost.moving,
          face: Math.round(lost.face * 10) / 10,
          tx: lost.tx,
          ty: lost.ty,
        }
      : null,
    ...(s.resumeTicks > 0 ? { resume: Math.ceil(s.resumeTicks / TICK_HZ) } : {}),
  };
}

const NO_MISC: NetMisc = { rift: null, arena: null, weather: null, event: null, lost: null };

function playerRow(p: PlayerState, time: number): number[] {
  return [
    q(p.x, PLAYER_POS),
    q(p.y, PLAYER_POS),
    q(p.vx, PLAYER_POS),
    q(p.vy, PLAYER_POS),
    q(p.aim, ANGLE),
    q(p.moveAngle, ANGLE),
    Math.ceil(Math.max(0, p.hp)),
    Math.round(p.maxHp),
    flags(
      p.dead,
      p.connected,
      p.left,
      p.walking,
      p.invuln > 0,
      p.inLiquid,
      p.slowT > 0,
      isAttacking(time, p),
    ),
    q(p.reviveT, 10),
    p.active,
  ];
}

function playerDetail(p: PlayerState): PlayerDetail {
  return {
    moves: p.moves.map((m) => ({
      id: m.id,
      level: m.level,
      evolved: m.evolved,
      kind: m.kind,
      type: m.type,
    })),
    slots: p.slots.map((s) => [...s]),
    maxSlots: p.maxSlots,
    item: p.item,
    bonds: p.bonds,
    rerollsLeft: Math.max(0, 1 + p.rerollBonus - p.rerollsUsed),
    types: [...p.types],
    magnet: Math.round(p.magnet),
    power: p.power ? { id: p.power.id, t: Math.ceil(p.power.t) } : null,
    buffs: [p.buffs.attack.n, p.buffs.speed.n, p.buffs.defense.n, p.buffs.regen.n],
  };
}

/** Cooldowns in 1/50 steps (enough for the HUD's fill), speed and momentum in 1/10 units. */
function selfState(s: SimState, p: PlayerState): SelfState {
  const speed = playerMoveSpeed(s, p);
  return {
    cooldowns: p.moves.map((m) => {
      const full = (m.stats.cooldown ?? 0) * p.cooldownMul;
      return m.kind === 'orbit' || full <= 0 ? 0 : Math.round(Math.min(1, m.t / full) * 50) / 50;
    }),
    speed: Math.round(speed * 10) / 10,
    momentum: Math.round(p.momentum * 10) / 10,
  };
}

const round = (v: number, step: number) => Math.round(v / step) * step;

/** Rounded to what the panel shows (and a little finer), so small drifts aren't resent. */
function selfStats(s: SimState, p: PlayerState): SelfStats {
  const x = playerStats(s, p);
  return {
    attackBase: x.attackBase,
    attack: round(x.attack, 0.1),
    speedBase: x.speedBase,
    speed: round(x.speed, 0.1),
    hpBase: x.hpBase,
    maxHp: Math.round(x.maxHp),
    cooldown: round(x.cooldown, 0.001),
    damageReduction: round(1 - 1 / (1 + x.defense), 0.001),
    defense: round(x.defense, 0.001),
    regen: round(x.regen, 0.01),
    magnet: round(x.magnet, 0.01),
    xp: round(x.xp, 0.01),
    crit: round(x.crit, 0.001),
  };
}

/** The fields every choice kind shares (2b's new kinds too). */
function choiceRef(c: PendingChoice): ChoiceRef {
  return { id: c.id, playerId: c.playerId, kind: c.kind, deadlineTick: c.deadlineTick };
}

// ------------------------------------------------------------------ decoder

/** Is this a full snapshot frame (one that doesn't need earlier ones)? */
export function isFullFrame(data: Uint8Array | string): boolean {
  try {
    const r: Reader =
      typeof data === 'string'
        ? new JsonReader(JSON.parse(data) as (number | string)[])
        : new BinaryReader(data);
    if (r.uint() !== FrameKind.snapshot) return false;
    const header: number[] = [];
    for (let i = r.uint(); i > 0; i--) header.push(r.int());
    return bit(header[H.flags] ?? 0, 0);
  } catch {
    return false;
  }
}

/** Client side: applies frames in order and returns the full current view after each one. */
export class SnapshotDecoder {
  private readonly tables = WIDTHS.map((w) => new TableDecoder(w));
  private strings = new Map<number, string>();
  private details: Record<string, PlayerDetail> = {};
  private world: Record<string, Record<string, number>> = {};
  private misc: NetMisc = NO_MISC;
  private shinies: number[] = [];
  private ended: RunEnd | null = null;
  private stats: SelfStats | null = null;
  private readonly events = new EventDecoder();
  /** Seq of the last frame applied. */
  private lastSeq = -1;

  /** `playerIds[index]`: the player id of each join-order index (from `GameStatic`). */
  constructor(readonly playerIds: readonly string[]) {}

  decode(data: Uint8Array | string): Snapshot {
    const r: Reader =
      typeof data === 'string'
        ? new JsonReader(JSON.parse(data) as (number | string)[])
        : new BinaryReader(data);
    const kind = r.uint();
    if (kind !== FrameKind.snapshot) throw new Error(`not a snapshot frame (${kind})`);
    const frame = readFrame(r, this.tables, (header) => {
      if (bit(header[H.flags] ?? 0, 0)) this.resetState();
      else if ((header[H.baseSeq] ?? -1) !== this.lastSeq)
        throw new Error(`snapshot gap: delta against ${header[H.baseSeq]}, have ${this.lastSeq}`);
    });
    this.lastSeq = frame.header[H.seq] ?? 0;
    const extra = JSON.parse(frame.json) as Extra;
    for (const [i, s] of Object.entries(extra.strings ?? {})) this.strings.set(Number(i), s);
    Object.assign(this.details, extra.details);
    for (const [name, changes] of Object.entries(extra.world ?? {})) {
      const record = (this.world[name] ??= {});
      for (const [key, v] of Object.entries(changes)) {
        if (v === null) delete record[key];
        else record[key] = v;
      }
    }
    if (extra.misc) this.misc = extra.misc;
    if (extra.shinies) this.shinies = extra.shinies;
    if (extra.ended !== undefined) this.ended = extra.ended;
    if (extra.stats) this.stats = extra.stats;
    this.events.addShapes(extra.shapes);
    const events = this.events.read(r, (i) => this.s(i));

    const h = frame.header;
    const f = h[H.flags] ?? 0;
    return {
      seq: h[H.seq] ?? 0,
      tick: h[H.tick] ?? 0,
      time: (h[H.timeMs] ?? 0) / 1000,
      ackSeq: h[H.ackSeq] ?? 0,
      full: bit(f, 0),
      paused: bit(f, 1),
      ended: this.ended,
      players: this.rows(T.players, (id, v) => this.player(id, v)),
      enemies: this.rows(T.enemies, (id, v) => this.enemy(id, v)),
      projectiles: this.rows(T.projectiles, (id, v) => this.projectile(id, v)),
      pickups: this.rows(T.pickups, (id, v) => ({
        id,
        kind: this.s(v[0]) ?? '',
        x: (v[1] ?? 0) / POS,
        y: (v[2] ?? 0) / POS,
        itemId: this.s(v[3]),
      })),
      fields: this.rows(T.fields, (id, v) => this.field(id, v)),
      hazards: this.rows(T.hazards, (id, v) => this.hazard(id, v)),
      team: this.team(),
      choices: extra.choices,
      waiting: extra.waiting,
      events,
      details: { ...this.details },
      world: Object.fromEntries(Object.entries(this.world).map(([k, v]) => [k, { ...v }])),
      misc: this.misc,
      self: extra.self ?? null,
      stats: this.stats,
    };
  }

  private resetState(): void {
    for (const t of this.tables) t.reset();
    this.strings.clear();
    this.details = {};
    this.world = {};
    this.misc = NO_MISC;
    this.shinies = [];
    this.ended = null;
    this.stats = null;
    this.events.reset();
  }

  private s(i: number | undefined): string | null {
    return i ? (this.strings.get(i) ?? null) : null;
  }

  private rows<R>(table: number, map: (id: number, v: number[]) => R): R[] {
    const out: R[] = [];
    for (const [id, v] of this.tables[table]!.rows) out.push(map(id, v));
    return out;
  }

  private player(index: number, v: number[]): NetPlayer {
    const fl = v[8] ?? 0;
    return {
      id: this.playerIds[index] ?? String(index),
      index,
      x: (v[0] ?? 0) / PLAYER_POS,
      y: (v[1] ?? 0) / PLAYER_POS,
      vx: (v[2] ?? 0) / PLAYER_POS,
      vy: (v[3] ?? 0) / PLAYER_POS,
      aim: (v[4] ?? 0) / ANGLE,
      moveAngle: (v[5] ?? 0) / ANGLE,
      hp: v[6] ?? 0,
      maxHp: v[7] ?? 0,
      dead: bit(fl, 0),
      connected: bit(fl, 1),
      left: bit(fl, 2),
      walking: bit(fl, 3),
      invulnerable: bit(fl, 4),
      inLiquid: bit(fl, 5),
      trapped: bit(fl, 6),
      attacking: bit(fl, 7),
      reviveT: (v[9] ?? 0) / 10,
      active: v[10] ?? 0,
    };
  }

  private enemy(id: number, v: number[]): NetEnemy {
    const fl = v[7] ?? 0;
    return {
      id,
      dex: v[0] ?? 0,
      x: (v[1] ?? 0) / POS,
      y: (v[2] ?? 0) / POS,
      r: v[3] ?? 0,
      hp: v[4] ?? 0,
      maxHp: v[5] ?? 0,
      face: (v[6] ?? 0) / ANGLE,
      boss: bit(fl, 0),
      shiny: bit(fl, 1),
      golden: bit(fl, 2),
      legend: bit(fl, 3),
      flying: bit(fl, 4),
      burning: bit(fl, 5),
      poisoned: bit(fl, 6),
      slowed: bit(fl, 7),
      shielded: bit(fl, 8),
      fury: bit(fl, 9),
      dead: bit(fl, 11),
      wildLegend: bit(fl, 12),
      phase: this.s(v[8]) ?? 'walk',
      scale: (v[9] ?? 100) / 100,
      height: v[10] ?? 0,
      jump: bit(fl, 10) ? (v[11] ?? 0) / 100 : null,
      behavior: this.s(v[12]) ?? 'chase',
      shield: v[13] ?? 0,
    };
  }

  private projectile(id: number, v: number[]): NetProjectile {
    const fl = v[4] ?? 0;
    const owner = v[5] ?? 0;
    return {
      id,
      x: (v[0] ?? 0) / POS,
      y: (v[1] ?? 0) / POS,
      r: v[2] ?? 0,
      angle: (v[3] ?? 0) / ANGLE,
      friendly: bit(fl, 0),
      orb: bit(fl, 1),
      returning: bit(fl, 2),
      ownerIndex: owner > 0 ? owner - 1 : null,
      type: this.s(v[6]),
      moveId: this.s(v[7]),
    };
  }

  private field(id: number, v: number[]): NetField {
    return {
      id,
      kind: this.s(v[0]) ?? '',
      x: (v[1] ?? 0) / POS,
      y: (v[2] ?? 0) / POS,
      r: v[3] ?? 0,
      type: this.s(v[4]) ?? '',
      ownerIndex: (v[5] ?? 1) - 1,
      moveId: this.s(v[8]) ?? '',
      arm: (v[6] ?? 0) / 10,
      progress: (v[7] ?? 0) / 100,
    };
  }

  private hazard(id: number, v: number[]): NetHazard {
    return {
      id,
      kind: this.s(v[0]) ?? '',
      x: (v[1] ?? 0) / POS,
      y: (v[2] ?? 0) / POS,
      r: v[3] ?? 0,
      angle: (v[4] ?? 0) / ANGLE,
      len: v[5] ?? 0,
      w: v[6] ?? 0,
      type: this.s(v[7]) ?? '',
      progress: (v[8] ?? 0) / 100,
      hit: (v[9] ?? 0) === 1,
    };
  }

  private team(): NetTeam {
    const v = this.tables[T.team]!.rows.get(0) ?? [];
    return {
      level: v[0] ?? 1,
      xp: v[1] ?? 0,
      xpNext: v[2] ?? 0,
      kills: v[3] ?? 0,
      bosses: v[4] ?? 0,
      coins: v[5] ?? 0,
      tickets: v[6] ?? 0,
      tickets10: v[7] ?? 0,
      biome: v[8] ?? 0,
      shinies: [...this.shinies],
    };
  }
}
