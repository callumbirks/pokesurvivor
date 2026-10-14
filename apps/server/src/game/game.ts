// One coop run: owns the sim, applies inputs and intents, sends snapshots, handles players
// dropping out and coming back, and produces the results. The room decides who plays; the
// GameServer's ticker calls `tick()` 30 times a second.
import { randomInt, randomUUID } from 'node:crypto';
import { SnapshotEncoder } from '@pokesurvivor/netclient';
import type { Game as GameStatic, ResultSummary } from '@pokesurvivor/netclient';
import { decodeAim, type InputMessage, type WireIntent } from '@pokesurvivor/protocol';
import { TICK_HZ, createSim } from '@pokesurvivor/sim';
import type { ChoiceResult, Intent, PlayerConfig, Sim, SimEvent } from '@pokesurvivor/sim';
import type { Session } from './session.js';

export interface GamePlayerInfo {
  userId: string;
  username: string;
  loadout: PlayerConfig;
  /** Pokémon they owned at the start (rescued ones they own pay coins instead). */
  owned: ReadonlySet<number>;
}

export interface GameSettings {
  snapshotHz: number;
  choiceTimeoutS: number;
  /** Tests: sim debug flags (no spawns, invulnerable). */
  simDebug?: { invulnerable?: boolean; noSpawns?: boolean };
}

export interface PlayerOutcome {
  userId: string;
  username: string;
  loadout: PlayerConfig;
  /** Left or was removed before the end. */
  left: boolean;
  summary: ResultSummary;
}

export interface GameOutcome {
  gameId: string;
  reason: string;
  startedAt: Date;
  endedAt: Date;
  durationS: number;
  players: PlayerOutcome[];
}

interface Slot extends GamePlayerInfo {
  index: number;
  encoder: SnapshotEncoder;
  /** The latest input: movement persists; a slot press waits until a tick applies it. */
  moveX: number;
  moveY: number;
  slot: number | null;
  /** Manual aim (radians, quantised on the wire), or null: auto-aim. Persists like movement. */
  aim: number | null;
  /** Fire held (with `aim`). Persists like movement. */
  fire: boolean;
  /** Highest input seq received / applied on the current socket. */
  lastSeq: number;
  ackSeq: number;
  connected: boolean;
  left: boolean;
  /** Results at the moment they left (credited for what they earned until then). */
  frozen: ResultSummary | null;
}

export type GamePhase = 'loading' | 'running' | 'ended';

export class Game {
  readonly id = randomUUID();
  readonly seed = randomInt(1, 2 ** 31 - 1);
  phase: GamePhase = 'loading';
  sim: Sim;
  info: GameStatic;
  startedAt = new Date();
  private slots = new Map<string, Slot>();
  private events: SimEvent[] = [];
  private snapAcc = 0;
  private seq = 0;
  private wasPaused = false;
  private snapshotDirty = false;

  constructor(
    readonly roomId: string,
    players: readonly GamePlayerInfo[],
    private readonly settings: GameSettings,
    private readonly sessionOf: (userId: string) => Session | null,
    private readonly onEnd: (game: Game, outcome: GameOutcome) => void,
  ) {
    this.sim = this.createSim(players);
    this.info = this.describe();
  }

  /** The run time, and whether it's standing still (loading, a pending choice, nobody connected). */
  get clock(): { elapsedS: number; paused: boolean } {
    if (this.phase !== 'running')
      return { elapsedS: this.phase === 'ended' ? this.sim.state.time : 0, paused: true };
    const anyone = [...this.slots.values()].some((s) => s.connected && !s.left);
    return { elapsedS: this.sim.state.time, paused: !anyone || this.sim.paused };
  }

  /** Players in the game (not including those who left). */
  get playerIds(): string[] {
    return [...this.slots.values()].filter((s) => !s.left).map((s) => s.userId);
  }

  has(userId: string): boolean {
    const slot = this.slots.get(userId);
    return !!slot && !slot.left;
  }

  private createSim(players: readonly GamePlayerInfo[]): Sim {
    const sim = createSim({
      seed: this.seed,
      players: players.map((p) => p.loadout),
      choiceTimeoutSeconds: this.settings.choiceTimeoutS,
      debug: this.settings.simDebug,
    });
    this.slots = new Map(
      players.map((p, index) => [
        p.userId,
        {
          ...p,
          index,
          encoder: new SnapshotEncoder({ viewerId: p.userId }),
          moveX: 0,
          moveY: 0,
          slot: null,
          aim: null,
          fire: false,
          lastSeq: 0,
          ackSeq: 0,
          connected: true,
          left: false,
          frozen: null,
        },
      ]),
    );
    return sim;
  }

  private describe(): GameStatic {
    return {
      roomId: this.roomId,
      gameId: this.id,
      seed: this.seed,
      tickHz: TICK_HZ,
      snapshotHz: this.settings.snapshotHz,
      choiceTimeoutS: this.settings.choiceTimeoutS,
      roster: this.sim.state.roster,
      players: [...this.slots.values()].map((s) => ({
        id: s.userId,
        username: s.username,
        index: s.index,
        dex: s.loadout.dex,
        shiny: this.sim.state.players[s.index]?.shiny ?? false,
      })),
    };
  }

  /**
   * Loading is over: the run starts with the players who loaded. If some were dropped the sim is
   * rebuilt without them (same seed, so the same world and roster).
   */
  start(loaded: readonly string[]): void {
    const players = [...this.slots.values()].filter((s) => loaded.includes(s.userId));
    if (players.length !== this.slots.size) {
      this.sim = this.createSim(players);
      this.info = this.describe();
    }
    this.phase = 'running';
    this.startedAt = new Date();
    for (const slot of this.slots.values()) {
      const session = this.sessionOf(slot.userId);
      if (!session) {
        // Loaded, then dropped before the start: they get their reconnect grace like anyone.
        this.disconnect(slot.userId);
        continue;
      }
      this.sendStart(slot, session, false);
    }
  }

  private sendStart(slot: Slot, session: Session, resumed: boolean): void {
    slot.encoder.reset();
    session.send({ type: 'game.start', game: this.info, resumed });
    // The full snapshot goes out now, so a resumed client doesn't wait for the next one.
    if (session.writable)
      session.sendBinary(
        slot.encoder.encode(this.sim.state, [], ++this.seq, slot.ackSeq) as Uint8Array,
      );
  }

  /** One tick (only while running). */
  tick(): void {
    if (this.phase !== 'running') return;
    const slots = [...this.slots.values()];
    // Nobody connected: the run is frozen until someone comes back or their grace runs out.
    if (!slots.some((s) => s.connected && !s.left)) return;
    for (const s of slots) {
      if (s.left) continue;
      this.sim.setInput(s.userId, {
        moveX: s.moveX,
        moveY: s.moveY,
        slot: s.slot,
        aim: s.aim,
        fire: s.fire,
      });
      s.slot = null;
      s.ackSeq = s.lastSeq;
    }
    this.sim.step();
    const events = this.sim.drainEvents();
    this.events.push(...events);
    if (events.some((e) => e.type === 'choice-resolved')) this.snapshotDirty = true;
    const paused = this.sim.paused;
    // Tick choices at 30 Hz (deadlines still run), but a frozen world only needs a heartbeat.
    // Choice mutations and pause/resume transitions are delivered on the very next tick.
    this.snapAcc += paused ? 1 : this.settings.snapshotHz;
    if (
      this.snapAcc >= TICK_HZ ||
      paused !== this.wasPaused ||
      this.snapshotDirty ||
      this.sim.ended
    ) {
      this.snapAcc = this.snapAcc >= TICK_HZ ? this.snapAcc - TICK_HZ : 0;
      this.snapshotDirty = false;
      this.sendSnapshots();
    }
    this.wasPaused = paused;
    if (this.sim.ended) this.finish(this.sim.state.ended?.reason ?? 'ended');
  }

  private sendSnapshots(): void {
    this.seq++;
    for (const slot of this.slots.values()) {
      if (slot.left || !slot.connected) continue;
      const session = this.sessionOf(slot.userId);
      // A client that can't keep up skips snapshots (its encoder keeps its baseline, so the
      // next one is still a correct delta); its events since then are lost (cosmetic).
      if (!session?.writable) continue;
      session.sendBinary(
        slot.encoder.encode(this.sim.state, this.events, this.seq, slot.ackSeq) as Uint8Array,
      );
    }
    this.events = [];
  }

  /**
   * The latest input wins. Order is tracked per player of this game (`slot.lastSeq`, reset when
   * they reconnect), never per socket: a socket outlives games, and each game's inputs count
   * from 1 again.
   */
  input(userId: string, m: InputMessage): void {
    const slot = this.slots.get(userId);
    if (this.phase !== 'running' || m.gameId !== this.id) return;
    if (!slot || slot.left || m.seq <= slot.lastSeq) return;
    slot.lastSeq = m.seq;
    slot.moveX = m.moveX;
    slot.moveY = m.moveY;
    if (m.slot != null) slot.slot = m.slot;
    slot.aim = m.aim === undefined ? null : decodeAim(m.aim);
    slot.fire = m.fire === true;
  }

  intent(userId: string, intent: WireIntent): ChoiceResult {
    if (this.phase !== 'running' || !this.has(userId)) return { ok: false, error: 'not playing' };
    // The sim validates the fields of each intent type and rejects unknown ones.
    const result = this.sim.submitIntent(userId, intent as unknown as Intent) as
      ChoiceResult | undefined;
    if (result?.ok) this.snapshotDirty = true;
    return result ?? { ok: false, error: 'unknown intent' };
  }

  /** The client lost track of the deltas: its next snapshot is full. */
  resync(userId: string): void {
    this.slots.get(userId)?.encoder.reset();
    this.snapshotDirty = true;
  }

  /** The player's socket closed: idle and invulnerable, their choices resolve by themselves. */
  disconnect(userId: string): void {
    const slot = this.slots.get(userId);
    if (!slot || slot.left) return;
    slot.connected = false;
    slot.moveX = slot.moveY = 0;
    slot.fire = false;
    slot.slot = null;
    this.sim.setConnected(userId, false);
    this.snapshotDirty = true;
  }

  /** Back within the grace period: a full snapshot and play continues. */
  reconnect(userId: string, session: Session): void {
    const slot = this.slots.get(userId);
    if (!slot || slot.left) return;
    slot.connected = true;
    slot.lastSeq = slot.ackSeq = 0;
    if (this.phase === 'running') {
      this.sim.setConnected(userId, true);
      this.snapshotDirty = true;
      this.sendStart(slot, session, true);
    }
  }

  /** Left for good (or the grace ran out). Credited with their results as of now. */
  removePlayer(userId: string): void {
    const slot = this.slots.get(userId);
    if (!slot || slot.left || this.phase === 'ended') return;
    slot.frozen = this.summaryOf(slot);
    slot.left = true;
    slot.connected = false;
    this.sim.removePlayer(userId);
    this.snapshotDirty = true;
    if (this.sim.ended) this.finish(this.sim.state.ended?.reason ?? 'everyone-left');
  }

  /** Ends the run now (server shutdown), crediting everyone with what they have. */
  forceEnd(reason: string): void {
    if (this.phase === 'ended') return;
    this.finish(reason);
  }

  private summaryOf(slot: Slot): ResultSummary {
    const owns = (dex: number) => slot.owned.has(dex);
    return {
      run: this.sim.runSummaryFor(slot.userId, owns),
      player:
        this.sim
          .summary((id, dex) => id === slot.userId && owns(dex))
          .players.find((p) => p.playerId === slot.userId) ?? null,
    };
  }

  private finish(reason: string): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    const endedAt = new Date();
    const players = [...this.slots.values()].map((slot) => ({
      userId: slot.userId,
      username: slot.username,
      loadout: slot.loadout,
      left: slot.left,
      summary: slot.frozen ?? this.summaryOf(slot),
    }));
    this.onEnd(this, {
      gameId: this.id,
      reason,
      startedAt: this.startedAt,
      endedAt,
      durationS: Math.floor(this.sim.state.time),
      players,
    });
  }
}
