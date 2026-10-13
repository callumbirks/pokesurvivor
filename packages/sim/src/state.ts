// The complete simulation state: plain JSON-compatible data (no classes, closures, Maps or Sets),
// so it can be snapshotted, hashed and diffed. Derived caches (chunk data, spatial grid, path
// fields) live outside it and are rebuilt from it.
import type { EnemyBehavior, MoveKind, MoveStats, PokemonType } from '@pokesurvivor/data';
import type { RngState } from './rng.js';

export type PlayerId = string;
export type EntityId = number;

export interface SimState {
  /** Ticks stepped, paused ones included (choice deadlines count in these). */
  tick: number;
  /** Seconds of play: only advances while the game runs (not while a choice is pending). */
  time: number;
  rng: RngState;
  nextId: EntityId;
  world: WorldState;
  /** In join order. Players who left stay here (with `left`) for the run summary. */
  players: PlayerState[];
  team: TeamState;
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  /** Things a move leaves on the map for a while: mines, falling meteors, turrets, trail pools. */
  fields: FieldState[];
  pickups: PickupState[];
  /** Telegraphed enemy attacks: drawn as a warning, they hit when `t` reaches `delay`. */
  hazards: HazardState[];
  spawner: SpawnerState;
  /** This run's wild Pokémon, rolled at start. Static afterwards. */
  roster: RosterState;
  /** Level-up cards and item swaps waiting for a player. While any is pending, the game is paused. */
  pendingChoices: PendingChoice[];
  nextChoiceId: number;
  /** Team level-ups that still have to hand out cards (one round of cards at a time). */
  pendingLevels: number;
  /** Tile each player's path field was last built around (the fields are rebuilt from these). */
  pathOrigins: Record<PlayerId, { tx: number; ty: number }>;
  /** Seconds until the path fields are rebuilt. */
  pathTimer: number;
  /** Seconds every remaining player has been down (the run ends after a short delay). */
  allDownT: number;
  ended: RunEnd | null;
  config: SimSettings;
}

export interface SimSettings {
  /** Ticks before a pending choice auto-resolves; null = never (solo). */
  choiceTimeoutTicks: number | null;
  /** Debug/tests: players take no damage. */
  invulnerable: boolean;
}

export interface RunEnd {
  reason: 'all-down' | 'everyone-left';
  tick: number;
  time: number;
}

// ---------------------------------------------------------------- world

export interface WorldState {
  seed: number;
  /** Index into the run biomes (cycles every 4 minutes). */
  biome: number;
  /** Destroyed props, by tile key `"tx,ty"`. */
  broken: Record<string, 1>;
  /** Remaining HP of damaged (not yet broken) props, by tile key. */
  propHp: Record<string, number>;
}

// ---------------------------------------------------------------- players

export interface PlayerInput {
  /** Movement direction; normalized by the sim if longer than 1. */
  moveX: number;
  moveY: number;
  /** Requested move slot, applied (and cleared) on the next running tick. */
  slot: number | null;
}

export interface BuffState {
  /** Stacks. */
  n: number;
  /** Seconds left. */
  t: number;
  /** Bonus per stack. */
  amount: number;
}

export type BuffStat = 'attack' | 'speed' | 'defense' | 'regen';

/** A learned move with its level-ups (and evolution) applied to its stats. */
export interface MoveState {
  id: string;
  kind: MoveKind;
  type: PokemonType;
  level: number;
  evolved: boolean;
  /** Current stats (base + upgrades + evolution). */
  stats: MoveStats;
  /** Cooldown timer: casts when it reaches 0. */
  t: number;
  /** `state.tick` of the last cast (the HUD flashes bonded moves). */
  castTick: number;
}

export type TargetRef = { kind: 'enemy'; id: EntityId } | { kind: 'prop'; key: string } | null;

export interface PlayerState {
  id: PlayerId;
  dex: number;
  shiny: boolean;
  types: PokemonType[];
  /** Join order: the colour/tag slot. */
  index: number;
  connected: boolean;
  left: boolean;
  input: PlayerInput;

  x: number;
  y: number;
  /** Collision radius. */
  r: number;
  /** Velocity actually applied last tick (ice slides keep it). */
  vx: number;
  vy: number;
  /** Smoothed velocity, used by enemies that cut you off and by straggler respawns. */
  smoothVx: number;
  smoothVy: number;
  prevX: number;
  prevY: number;
  walking: boolean;
  moveAngle: number;
  aim: number;
  target: TargetRef;

  hp: number;
  maxHp: number;
  baseSpeed: number;
  baseAttack: number;
  attackMul: number;
  speedMul: number;
  cooldownMul: number;
  damageReduction: number;
  /** Flat HP regenerated per second (perks, cards, Leftovers). */
  regen: number;
  /** Pickup radius. */
  magnet: number;
  xpMul: number;
  coinMul: number;
  critChance: number;
  buffs: Record<BuffStat, BuffState>;

  /** All learned moves. */
  moves: MoveState[];
  /** Move slots (1–4 on the keyboard): each lists the ids of the moves cast together. */
  slots: string[][];
  active: number;
  maxSlots: number;
  /** Unused bonds (2b: legendary rewards that fuse moves into one slot). */
  bonds: number;
  /** Moves this player never gets offered (permanent "Ban" upgrade). */
  banned: string[];
  /** Move id → preferred slot (permanent "Shortcuts" setting). */
  bind: Record<string, number>;
  rerollsUsed: number;
  rerollBonus: number;
  /** Times each level-up stat card was taken (move evolutions need one). */
  statsTaken: Record<string, number>;
  item: string | null;
  /** Regen Leftovers added when equipped (removed again on swap). */
  itemRegen: number;
  /** `state.time` Focus Sash last saved you (null: never). */
  sashAt: number | null;
  /** Shell Bell healing still to be applied. */
  bellHeal: number;

  invuln: number;
  /** Seconds left stuck by a trap (2b): half speed. */
  slowT: number;
  inLiquid: boolean;
  lavaTick: number;
  dead: boolean;
  /** Revive progress while down (a teammate standing next to you). */
  reviveT: number;
  orbCastT: number;
  lastPatchId: EntityId | null;

  stats: PlayerRunStats;
}

export interface PlayerRunStats {
  damageDealt: number;
  /** Enemies this player landed the final hit on. */
  lastHits: number;
  timesDown: number;
  revivesGiven: number;
  /** Progress events for missions and achievements (aggregated; see `progress` events). */
  progress: ProgressTotals;
}

export interface ProgressTotals {
  defeats: number;
  /** Defeats per Pokémon type (a dual-type Pokémon counts for both). */
  defeatsByType: Partial<Record<PokemonType, number>>;
  bossDefeats: number;
  /** Legendaries defeated (dex numbers, 2b). */
  legendaries: number[];
  chestsOpened: number;
  /** Items equipped (ids, in order). */
  itemsFound: string[];
  /** Moves evolved (ids). */
  evolutions: string[];
  riftWins: number;
}

/** Shared by the whole team, as in legacy co-op: one XP bar, one level, one loot pile. */
export interface TeamState {
  level: number;
  xp: number;
  xpNext: number;
  kills: number;
  bosses: number;
  /** Coins picked up during the run. */
  coins: number;
  /** Gacha tickets picked up. */
  tickets: number;
  tickets10: number;
  /** Shiny wild Pokémon defeated (everyone gets them). */
  shinies: number[];
}

// ---------------------------------------------------------------- enemies

/** What an enemy is: its Pokémon, behaviour and base stats (before run scaling). */
export interface EnemyDef {
  dex: number;
  behavior: EnemyBehavior;
  hp: number;
  speed: number;
  damage: number;
  xp: number;
  /** Ranged behaviours: shot damage, cooldown and range. */
  shotDamage?: number;
  shotCooldown?: number;
  range?: number;
  /** Summoners: the Pokémon they call in. */
  minion?: number;
  /** Fans: shots per volley. Zoners: zones per cast. */
  fanCount?: number;
  zones?: number;
  /** Treasure thieves (2b): what they drop. */
  loot?: 'coins' | 'ticket10';
}

export interface BossDef extends EnemyDef {
  /** Second of the run it appears at. */
  at: number;
}

export interface RosterTier {
  from: number;
  list: EnemyDef[];
}

export interface RosterState {
  tiers: RosterTier[];
  bosses: BossDef[];
}

export interface EnemyScale {
  hp: number;
  speed: number;
  damage: number;
}

export type BossSkill = 'slam' | 'dash' | 'leap' | 'rain' | 'beam' | 'nova' | 'volley';

export interface BossCast {
  id: BossSkill;
  t: number;
  wind: number;
  after: number;
  angle: number;
  len: number;
  dur: number;
  go: boolean;
  fired: boolean;
}

export interface BossAi {
  melee: BossSkill[];
  ranged: BossSkill[];
  farLike: number;
  mode: 'far' | 'close';
  modeT: number;
  cd: number;
  cast: BossCast | null;
  fury: boolean;
  side: number;
}

export interface JumpState {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
}

export interface EnemyState {
  id: EntityId;
  dex: number;
  def: EnemyDef;
  x: number;
  y: number;
  r: number;
  /** Visual height (for the client's health bars and numbers). */
  height: number;
  scale: number;
  boss: boolean;
  /** Rift legendary (2b). */
  legend: boolean;
  shiny: boolean;
  /** Golden hour (2b): double XP. */
  golden: boolean;
  flying: boolean;
  types: PokemonType[];
  attackType: PokemonType;
  behavior: EnemyBehavior;

  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xp: number;
  /** Run scale it was spawned with (its minions use it too). */
  sc: EnemyScale;

  slow: number;
  slowT: number;
  burn: number;
  burnT: number;
  burnTick: number;
  poison: number;
  poisonT: number;
  poisonTick: number;
  lavaTick: number;
  kx: number;
  ky: number;
  touchCd: number;
  dead: boolean;
  /** Facing angle (for rendering). */
  face: number;

  /** Charger / bomber state machine. */
  phase: 'walk' | 'aim' | 'dash' | 'fuse';
  pt: number;
  dashX: number;
  dashY: number;
  shotCd: number;
  stuckT: number;
  sideT: number;
  side: number;
  shield: number;
  shieldT: number;
  skillCd: number;
  minions: EntityId[];
  jump: JumpState | null;
  /** Seconds lagging behind out of everyone's view. */
  lagT: number;
  /** Thief zig-zag phase and seconds left before escaping (2b; null: stays). */
  zig: number;
  life: number | null;
  /** Line of sight to its target, re-checked every 0.2 s. */
  losT: number;
  los: boolean;
  ai: BossAi | null;
  lastHitBy: PlayerId | null;
}

// ---------------------------------------------------------------- projectiles, fields, hazards

export interface StatusPayload {
  burn: number;
  poison: number;
  slow: number;
  knockback: number;
}

export interface ProjectileState extends StatusPayload {
  id: EntityId;
  /** Fired by a player (true) or an enemy (false). */
  friendly: boolean;
  ownerId: PlayerId | null;
  /** Move that fired it (player shots), for the client's visuals. */
  moveId: string | null;
  /** Attack type (type chart). */
  type: PokemonType | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Position before the last move (swept collision). */
  px: number;
  py: number;
  damage: number;
  r: number;
  life: number;
  t: number;
  pierce: number;
  homing: number;
  /** Enemies already hit (shots hit each enemy once). */
  hits: EntityId[];
  /** Props already hit. */
  propHits: string[];
  /** Orbs circle their owner for as long as the move is active and re-hit every `rehit` s. */
  orb: boolean;
  orbAngle: number;
  orbRadius: number;
  orbSpeed: number;
  rehit: number;
  /** Orbs: key (`e<id>` / `p<tile>`) → `state.time` of the last hit. */
  hitLog: Record<string, number>;
  /** Boomerangs: seconds out before turning back, return speed, and whether it's coming back. */
  boomerang: number;
  returnSpeed: number;
  back: boolean;
}

export type FieldKind = 'mine' | 'meteor' | 'turret' | 'patch';

export interface FieldState extends StatusPayload {
  id: EntityId;
  kind: FieldKind;
  ownerId: PlayerId;
  moveId: string;
  type: PokemonType;
  x: number;
  y: number;
  t: number;
  /** Lifetime (0 = none). Mines blow up at the end of theirs; the others vanish. */
  life: number;
  r: number;
  damage: number;
  /** Mines: seconds before armed. Meteors: seconds to land. */
  arm: number;
  /** Turrets: next shot timer, range, rate, shot speed, size, pierce. Patches: damage tick. */
  shotT: number;
  range: number;
  rate: number;
  speed: number;
  size: number;
  pierce: number;
  gone: boolean;
}

export interface HazardState {
  id: EntityId;
  kind: 'zone' | 'beam';
  x: number;
  y: number;
  /** Zone radius. */
  r: number;
  /** Beam direction, length and width. */
  angle: number;
  len: number;
  w: number;
  delay: number;
  damage: number;
  type: PokemonType;
  t: number;
  hit: boolean;
}

// ---------------------------------------------------------------- pickups

export type PickupKind =
  'xp' | 'xp-big' | 'coin' | 'heal' | 'magnet' | 'bomb' | 'ticket' | 'ticket10' | 'item';

export interface PickupState {
  id: EntityId;
  kind: PickupKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** XP or coin amount. */
  value: number;
  /** Held item id (kind `item`). */
  itemId: string | null;
  pulled: boolean;
}

// ---------------------------------------------------------------- spawner

export interface SpawnerState {
  acc: number;
  bossIndex: number;
  surgeT: number;
  /** Debug: the next N spawns are shiny. */
  forceShiny: number;
}

// ---------------------------------------------------------------- choices

export type CardType = 'new' | 'upgrade' | 'evolution' | 'stat';

/** A level-up card. Display text comes from the data (move / stat card) on the client. */
export interface CardOption {
  /** Unique within an offer: `new:<move>`, `upgrade:<move>`, `evolution:<move>`, `stat:<card>`. */
  id: string;
  type: CardType;
  moveId?: string;
  statId?: string;
  /** Upgrade cards: the level the move goes to. */
  toLevel?: number;
  /** Stat cards that unlock a waiting evolution: the move that's waiting. */
  unlocksEvolutionOf?: string;
}

interface ChoiceBase {
  id: number;
  playerId: PlayerId;
  /** `state.tick` it auto-resolves at (null: never). */
  deadlineTick: number | null;
}

export interface LevelUpChoice extends ChoiceBase {
  kind: 'level-up';
  level: number;
  options: CardOption[];
}

/** Picked up a second held item: keep the one you have or switch. */
export interface ItemChoice extends ChoiceBase {
  kind: 'item';
  held: string;
  found: string;
}

export type PendingChoice = LevelUpChoice | ItemChoice;
