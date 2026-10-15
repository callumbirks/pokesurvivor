// One coop run: owns the sim, applies inputs and intents, sends snapshots, handles players
// dropping out and coming back, and produces the results. The room decides who plays; the
// GameServer's ticker calls `tick()` 30 times a second.
import { randomInt, randomUUID } from 'node:crypto';
import { SnapshotEncoder } from '@pokesurvivor/netclient';
import type { Game as GameStatic, ResultSummary } from '@pokesurvivor/netclient';
import { decodeAim, type InputMessage, type WireIntent } from '@pokesurvivor/protocol';
import { TICK_HZ, createSim, restoreSim } from '@pokesurvivor/sim';
import type {
  ChoiceResult,
  Intent,
  PlayerConfig,
  Sim,
  SimEvent,
  SimState,
} from '@pokesurvivor/sim';
import type { SavedGame } from './saved.js';
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
  /** Spectating while down (`game.spectate`): whose surroundings their snapshots show. */
  spectate: string | null;
  /** Highest input seq received / applied on the current socket. */
  lastSeq: number;
  ackSeq: number;
  connected: boolean;
  left: boolean;
  /** Results at the moment they left (credited for what they earned until then). */
  frozen: ResultSummary | null;
}

export type GamePhase = 'loading' | 'running' | 'ended';

/** A game read back from `game_saves` (see `Game.restore`). */
interface Restored {
  gameId: string;
  saved: SavedGame;
  sim: Sim;
}

export class Game {
  readonly id: string;
  readonly seed: number;
  phase: GamePhase = 'loading';
  sim: Sim;
  info: GameStatic;
  startedAt = new Date();
  /**
   * Restored after a server update and waiting for its players: the sim stands still, snapshots
   * say paused (clients don't predict or send movement), until `resume()`.
   */
  held = false;
  /** Being saved for a server update: nothing changes any more. */
  frozen = false;
  /** Players a held game still waits for (set by the room on restore). */
  waitingFor = new Set<string>();
  private slots = new Map<string, Slot>();
  private events: SimEvent[] = [];
  private snapAcc = 0;
  private seq = 0;
  private wasPaused = false;
  private snapshotDirty = false;

  constructor(
    readonly roomId: string,
    from: readonly GamePlayerInfo[] | Restored,
    private readonly settings: GameSettings,
    private readonly sessionOf: (userId: string) => Session | null,
    private readonly onEnd: (game: Game, outcome: GameOutcome) => void,
  ) {
    if ('saved' in from) {
      const { saved } = from;
      this.id = from.gameId;
      this.seed = saved.seed;
      this.sim = from.sim;
      this.info = saved.info;
      this.phase = 'running';
      this.held = true;
      this.startedAt = new Date(saved.startedAt);
      this.slots = new Map(
        saved.slots.map((s) => [
          s.userId,
          {
            ...this.newSlot({ ...s, owned: new Set(s.owned) }, s.index),
            // Nobody is connected until they reconnect to this server.
            connected: false,
            left: s.left,
            frozen: s.frozen ?? null,
          },
        ]),
      );
    } else {
      this.id = randomUUID();
      this.seed = randomInt(1, 2 ** 31 - 1);
      this.sim = this.createSim(from);
      this.info = this.describe();
    }
  }

  /**
   * Rebuilds a saved game, held until its players are back. Throws if the saved state doesn't
   * fit this server's sim (the caller then credits the saved results instead).
   */
  static restore(
    gameId: string,
    saved: SavedGame,
    simJson: string,
    settings: GameSettings,
    sessionOf: (userId: string) => Session | null,
    onEnd: (game: Game, outcome: GameOutcome) => void,
  ): Game {
    const sim = restoreSim(JSON.parse(simJson) as SimState);
    const game = new Game(saved.room.id, { gameId, saved, sim }, settings, sessionOf, onEnd);
    // Every slot must be its player in the sim, and the summaries (what gets credited) must work.
    for (const slot of game.slots.values()) {
      if (sim.state.players[slot.index]?.id !== slot.userId)
        throw new Error(`saved slot ${slot.index} is not ${slot.userId} in the sim`);
      game.summaryOf(slot);
    }
    sim.hash();
    return game;
  }

  /** Everything needed to restore this game on another server (see `SavedGame`). */
  save(room: SavedGame['room']): { saved: SavedGame; sim: string } {
    const slots = [...this.slots.values()];
    return {
      saved: {
        room,
        info: this.info,
        seed: this.seed,
        startedAt: this.startedAt.toISOString(),
        slots: slots.map((s) => ({
          userId: s.userId,
          username: s.username,
          index: s.index,
          loadout: s.loadout,
          owned: [...s.owned],
          left: s.left,
          frozen: s.frozen,
        })),
        // Still waiting for some after a restore: they count as present until they're back.
        present: slots
          .filter((s) => !s.left && (s.connected || this.waitingFor.has(s.userId)))
          .map((s) => s.userId),
        outcome: this.outcomes(),
        timeS: this.sim.state.time,
      },
      sim: JSON.stringify(this.sim.state),
    };
  }

  /** The run time, and whether it's standing still (loading, a pending choice, nobody connected). */
  get clock(): { elapsedS: number; paused: boolean } {
    if (this.phase !== 'running')
      return { elapsedS: this.phase === 'ended' ? this.sim.state.time : 0, paused: true };
    const anyone = [...this.slots.values()].some((s) => s.connected && !s.left);
    return { elapsedS: this.sim.state.time, paused: !anyone || this.held || this.sim.paused };
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
    this.slots = new Map(players.map((p, index) => [p.userId, this.newSlot(p, index)]));
    return sim;
  }

  private newSlot(p: GamePlayerInfo, index: number): Slot {
    return {
      userId: p.userId,
      username: p.username,
      loadout: p.loadout,
      owned: p.owned,
      index,
      encoder: new SnapshotEncoder({ viewerId: p.userId }),
      moveX: 0,
      moveY: 0,
      slot: null,
      aim: null,
      fire: false,
      spectate: null,
      lastSeq: 0,
      ackSeq: 0,
      connected: true,
      left: false,
      frozen: null,
    };
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
        ...(s.loadout.prestige ? { prestige: s.loadout.prestige } : {}),
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
        slot.encoder.encode(this.sim.state, [], ++this.seq, slot.ackSeq, {
          paused: this.held,
        }) as Uint8Array,
      );
  }

  /**
   * The restored game goes on: everyone connected starts again from a full snapshot, with no
   * movement held and input seqs from 1 (as after a reconnect), so nothing sent while it was
   * held, or before the update, is applied.
   */
  resume(): void {
    if (!this.held || this.phase !== 'running') return;
    this.held = false;
    this.waitingFor.clear();
    for (const slot of this.slots.values()) {
      if (slot.left || !slot.connected) continue;
      slot.moveX = slot.moveY = 0;
      slot.slot = null;
      slot.aim = null;
      slot.fire = false;
      slot.lastSeq = slot.ackSeq = 0;
      const session = this.sessionOf(slot.userId);
      if (session) this.sendStart(slot, session, true);
    }
    this.snapshotDirty = true;
  }

  /** One tick (only while running). */
  tick(): void {
    if (this.phase !== 'running' || this.frozen) return;
    // Held: the sim stands still; changes (a reconnect, a choice picked) still go out.
    if (this.held) {
      if (this.snapshotDirty) {
        this.snapshotDirty = false;
        this.sendSnapshots();
      }
      return;
    }
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
    // A full resume frame discards the client's sparse paused interpolation history. Keep
    // the reset even for backpressured sockets: their next writable frame must also be full.
    if (this.wasPaused && !paused) for (const slot of slots) slot.encoder.reset();
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
      slot.encoder.focusId = this.spectating(slot);
      const session = this.sessionOf(slot.userId);
      // A client that can't keep up skips snapshots (its encoder keeps its baseline, so the
      // next one is still a correct delta); its events since then are lost (cosmetic).
      if (!session?.writable) continue;
      session.sendBinary(
        slot.encoder.encode(this.sim.state, this.events, this.seq, slot.ackSeq, {
          paused: this.held,
        }) as Uint8Array,
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
    // Held or being saved: movement sent now would be stale when it goes on.
    if (this.phase !== 'running' || this.held || this.frozen || m.gameId !== this.id) return;
    if (!slot || slot.left || m.seq <= slot.lastSeq) return;
    slot.lastSeq = m.seq;
    slot.moveX = m.moveX;
    slot.moveY = m.moveY;
    if (m.slot != null) slot.slot = m.slot;
    slot.aim = m.aim === undefined ? null : decodeAim(m.aim);
    slot.fire = m.fire === true;
  }

  /**
   * While down, a player can watch a teammate: their snapshots' interest area follows the target
   * (their own state, choices and stats still come). Anything else clears it: a target that is
   * themselves, not in the game or not connected, or the sender not down.
   */
  spectate(userId: string, gameId: string, target: string | null): void {
    const slot = this.slots.get(userId);
    if (this.phase !== 'running' || gameId !== this.id || !slot || slot.left) return;
    slot.spectate = target === userId ? null : target;
    if (this.spectating(slot) !== slot.encoder.focusId) this.snapshotDirty = true;
  }

  /** Whom `slot` spectates now; null once they're revived or the target is gone (cleared). */
  private spectating(slot: Slot): string | null {
    if (slot.spectate === null) return null;
    const me = this.sim.state.players[slot.index];
    const target = this.slots.get(slot.spectate);
    const player = target && this.sim.state.players[target.index];
    if (!me?.dead || !target || target.left || !target.connected || !player || player.left)
      slot.spectate = null;
    return slot.spectate;
  }

  intent(userId: string, intent: WireIntent): ChoiceResult {
    if (this.phase !== 'running' || this.frozen || !this.has(userId))
      return { ok: false, error: 'not playing' };
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
    // A fresh client starts on its own Pokémon (it asks again if it wants to spectate).
    slot.spectate = null;
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

  /** Every player's result now (those who left: as of then). */
  private outcomes(): PlayerOutcome[] {
    return [...this.slots.values()].map((slot) => ({
      userId: slot.userId,
      username: slot.username,
      loadout: slot.loadout,
      left: slot.left,
      summary: slot.frozen ?? this.summaryOf(slot),
    }));
  }

  private finish(reason: string): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    const endedAt = new Date();
    const players = this.outcomes();
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
