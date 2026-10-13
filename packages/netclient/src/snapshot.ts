// Snapshots: what one client sees of the sim, as delta-compressed integer tables plus a small
// JSON part. `SnapshotEncoder` (server: one per client and game; the future solo adapter can use
// it too) projects the sim state for one viewer; `SnapshotDecoder` (client) rebuilds the view.
//
// Interest management: enemies, projectiles, pickups, fields and hazards are sent only near the
// viewer's Pokémon (enter within `radius`, leave beyond `radius + hysteresis`); players and the
// team always. Strings (pickup kinds, move ids, types, …) go through a per-connection string
// table, so new kinds the sim adds (2b) need no wire changes. Pending choices are state: every
// snapshot lists all of them (the viewer's own in full).
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
import type {
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
  flying: boolean;
  burning: boolean;
  poisoned: boolean;
  slowed: boolean;
  shielded: boolean;
  fury: boolean;
  dead: boolean;
  phase: string;
  scale: number;
  height: number;
  /** 0–1 through a jump, or null. */
  jump: number | null;
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
  /** Mines: seconds before armed; meteors: seconds to land. */
  arm: number;
  /** 0–1 through its life (0 if it has none). */
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
}

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
  world: { broken: Record<string, 1>; propHp: Record<string, number> };
}

// ------------------------------------------------------------------ tables

const T = { players: 0, enemies: 1, projectiles: 2, pickups: 3, fields: 4, hazards: 5, team: 6 };
const WIDTHS = [11, 12, 8, 4, 9, 10, 9];

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
  broken?: string[];
  unbroken?: string[];
  propHp?: Record<string, number | null>;
  shinies?: number[];
  ended?: RunEnd | null;
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
  private broken = new Set<string>();
  private propHp = new Map<string, number>();
  private shinies = '';
  private ended: string | null = null;
  private full = true;
  private lastSeq = 0;
  private readonly events = new EventEncoder((s) => this.str(s));
  readonly viewerId: string;
  readonly radius: number;
  readonly format: SnapshotFormat;

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
    this.broken.clear();
    this.propHp.clear();
    this.shinies = '';
    this.ended = null;
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

  encode(
    s: SimState,
    events: readonly SimEvent[],
    seq: number,
    ackSeq: number,
  ): Uint8Array | string {
    const viewer = s.players.find((p) => p.id === this.viewerId);
    const cx = viewer?.x ?? 0;
    const cy = viewer?.y ?? 0;
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
    for (const p of s.players) rows[T.players]!.set(p.index, playerRow(p));
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
      flags(this.full, s.pendingChoices.length > 0),
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
      ),
      this.str(e.phase),
      q(e.scale, 100),
      Math.round(e.height),
      e.jump ? Math.round((100 * e.jump.t) / (e.jump.dur || 1)) : 0,
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
      q(Math.max(0, f.arm), 10),
      f.life > 0 ? Math.round((100 * f.t) / f.life) : 0,
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

  private addDetails(s: SimState, extra: Extra): void {
    for (const p of s.players) {
      const detail = playerDetail(p);
      const json = JSON.stringify(detail);
      if (this.details.get(p.id) === json) continue;
      this.details.set(p.id, json);
      (extra.details ??= {})[p.id] = detail;
    }
  }

  private addWorld(s: SimState, extra: Extra): void {
    const broken = Object.keys(s.world.broken);
    for (const key of broken) {
      if (this.broken.has(key)) continue;
      this.broken.add(key);
      (extra.broken ??= []).push(key);
    }
    if (this.broken.size > broken.length) {
      for (const key of this.broken) {
        if (s.world.broken[key]) continue;
        this.broken.delete(key);
        (extra.unbroken ??= []).push(key);
      }
    }
    for (const [key, hp] of Object.entries(s.world.propHp)) {
      const rounded = Math.ceil(hp);
      if (this.propHp.get(key) === rounded) continue;
      this.propHp.set(key, rounded);
      (extra.propHp ??= {})[key] = rounded;
    }
    for (const key of this.propHp.keys()) {
      if (key in s.world.propHp) continue;
      this.propHp.delete(key);
      (extra.propHp ??= {})[key] = null;
    }
  }
}

function playerRow(p: PlayerState): number[] {
  return [
    q(p.x, PLAYER_POS),
    q(p.y, PLAYER_POS),
    q(p.vx, PLAYER_POS),
    q(p.vy, PLAYER_POS),
    q(p.aim, ANGLE),
    q(p.moveAngle, ANGLE),
    Math.ceil(Math.max(0, p.hp)),
    Math.round(p.maxHp),
    flags(p.dead, p.connected, p.left, p.walking, p.invuln > 0, p.inLiquid),
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
  private broken: Record<string, 1> = {};
  private propHp: Record<string, number> = {};
  private shinies: number[] = [];
  private ended: RunEnd | null = null;
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
    for (const key of extra.broken ?? []) this.broken[key] = 1;
    for (const key of extra.unbroken ?? []) delete this.broken[key];
    for (const [key, hp] of Object.entries(extra.propHp ?? {})) {
      if (hp === null) delete this.propHp[key];
      else this.propHp[key] = hp;
    }
    if (extra.shinies) this.shinies = extra.shinies;
    if (extra.ended !== undefined) this.ended = extra.ended;
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
      world: { broken: { ...this.broken }, propHp: { ...this.propHp } },
    };
  }

  private resetState(): void {
    for (const t of this.tables) t.reset();
    this.strings.clear();
    this.details = {};
    this.broken = {};
    this.propHp = {};
    this.shinies = [];
    this.ended = null;
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
      phase: this.s(v[8]) ?? 'walk',
      scale: (v[9] ?? 100) / 100,
      height: v[10] ?? 0,
      jump: bit(fl, 10) ? (v[11] ?? 0) / 100 : null,
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
