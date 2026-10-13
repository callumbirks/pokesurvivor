// RoomConnection: what the game screen talks to while a run is on. The network implementation
// is below; the solo adapter (phase 4: the sim in a Web Worker) implements the same interface,
// so the renderer, HUD and input code don't care whether the run is local or on the server.
import type { InputMessage } from '@pokesurvivor/protocol';
import type { Intent, MoveInput } from '@pokesurvivor/sim';
import { TICK_MS } from '@pokesurvivor/sim';
import { SnapshotBuffer, type SnapshotBufferOptions } from './buffer.js';
import { Emitter } from './emitter.js';
import { timers } from './timers.js';
import { SnapshotDecoder, isFullFrame, type NetPlayer, type Snapshot } from './snapshot.js';
import type { Game, IntentResult, Results } from './types.js';

export type RoomConnectionPhase = 'loading' | 'running' | 'ended';

export interface RoomConnectionEvents extends Record<string, unknown> {
  /** A game is loading (`game` is set): load its assets, then call `loaded()`. */
  loading: { game: Game };
  /** A game started or was resumed (a full snapshot follows). */
  start: { game: Game; resumed: boolean };
  snapshot: Snapshot;
  results: Results;
  phase: RoomConnectionPhase;
}

/** An input as sent, kept until the server acks it (prediction replays these). */
export interface SentInput {
  seq: number;
  moveX: number;
  moveY: number;
  slot: number | null;
  sentAt: number;
}

export interface RoomConnection {
  readonly selfId: string;
  readonly game: Game | null;
  readonly phase: RoomConnectionPhase;
  /** Snapshots for rendering (interpolation helpers in `buffer.ts`). */
  readonly buffer: SnapshotBuffer;
  readonly latest: Snapshot | null;

  /** Prediction hooks: the last input the server applied, and our Pokémon as it last saw it. */
  readonly ackedInputSeq: number;
  readonly serverSelf: NetPlayer | null;
  /** Inputs sent but not yet applied by the server, oldest first. */
  unackedInputs(): readonly SentInput[];

  /** Tell the server the assets are loaded (during `loading`). */
  loaded(): void;
  /** Sends movement (persists until changed) and an optional one-shot slot switch. */
  sendInput(input: MoveInput): number;
  /** Samples `read` every tick and sends it while the game runs. Returns a stop function. */
  startInputLoop(read: () => MoveInput): () => void;
  intent(intent: Intent): Promise<IntentResult>;
  /** Solo only: stop or resume the run (multiplayer runs never pause for one player). */
  setPaused?(paused: boolean): void;
  on<K extends keyof RoomConnectionEvents>(
    event: K,
    handler: (payload: RoomConnectionEvents[K]) => void,
  ): () => void;
}

/** What `NetRoomConnection` needs from the client that owns the socket. */
export interface RoomTransport {
  send(message: InputMessage | { type: 'game.loaded' | 'game.resync'; gameId: string }): boolean;
  request(message: { type: 'intent'; intent: Intent }): Promise<unknown>;
  now(): number;
}

const MAX_UNACKED = 240;

export class NetRoomConnection implements RoomConnection {
  game: Game | null = null;
  phase: RoomConnectionPhase = 'loading';
  readonly buffer: SnapshotBuffer;
  ackedInputSeq = 0;
  private decoder: SnapshotDecoder | null = null;
  private readonly emitter = new Emitter<RoomConnectionEvents>();
  private seq = 0;
  private unacked: SentInput[] = [];
  private loadedGameId: string | null = null;
  private resyncing = false;

  constructor(
    readonly selfId: string,
    private readonly transport: RoomTransport,
    bufferOptions?: SnapshotBufferOptions,
  ) {
    this.buffer = new SnapshotBuffer(bufferOptions);
  }

  get latest(): Snapshot | null {
    return this.buffer.latest;
  }

  get serverSelf(): NetPlayer | null {
    return this.latest?.players.find((p) => p.id === this.selfId) ?? null;
  }

  on<K extends keyof RoomConnectionEvents>(
    event: K,
    handler: (payload: RoomConnectionEvents[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  next<K extends keyof RoomConnectionEvents>(
    event: K,
    filter?: (payload: RoomConnectionEvents[K]) => boolean,
  ): Promise<RoomConnectionEvents[K]> {
    return this.emitter.next(event, filter);
  }

  unackedInputs(): readonly SentInput[] {
    return this.unacked;
  }

  loaded(): void {
    if (!this.game || this.phase !== 'loading') return;
    this.loadedGameId = this.game.gameId;
    this.transport.send({ type: 'game.loaded', gameId: this.game.gameId });
  }

  sendInput(input: MoveInput): number {
    const seq = ++this.seq;
    const slot = input.slot ?? null;
    const message: InputMessage = { type: 'input', seq, moveX: input.moveX, moveY: input.moveY };
    if (slot !== null) message.slot = slot;
    if (this.transport.send(message)) {
      this.unacked.push({
        seq,
        moveX: input.moveX,
        moveY: input.moveY,
        slot,
        sentAt: this.transport.now(),
      });
      if (this.unacked.length > MAX_UNACKED) this.unacked.shift();
    }
    return seq;
  }

  startInputLoop(read: () => MoveInput): () => void {
    const timer = timers.setInterval(() => {
      if (this.phase === 'running') this.sendInput(read());
    }, TICK_MS);
    return () => timers.clearInterval(timer);
  }

  async intent(intent: Intent): Promise<IntentResult> {
    try {
      await this.transport.request({ type: 'intent', intent });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------- driven by NetClient

  /** @internal */
  handleLoading(game: Game): void {
    this.game = game;
    this.setPhase('loading');
    this.emitter.emit('loading', { game });
    // A reconnect during loading: ack again if the app already loaded this game.
    if (this.loadedGameId === game.gameId)
      this.transport.send({ type: 'game.loaded', gameId: game.gameId });
  }

  /** @internal */
  handleStart(game: Game, resumed: boolean): void {
    this.game = game;
    this.decoder = new SnapshotDecoder(
      [...game.players].sort((a, b) => a.index - b.index).map((p) => p.id),
    );
    this.buffer.clear();
    this.resyncing = false;
    this.setPhase('running');
    this.emitter.emit('start', { game, resumed });
  }

  /** @internal */
  handleFrame(data: Uint8Array, receivedAt: number): Snapshot | null {
    if (!this.decoder || !this.game) return null;
    // After a bad frame, deltas are useless until the full snapshot we asked for.
    if (this.resyncing && !isFullFrame(data)) return null;
    let snap: Snapshot;
    try {
      snap = this.decoder.decode(data);
    } catch {
      this.resyncing = true;
      this.decoder = new SnapshotDecoder(this.decoder.playerIds);
      this.transport.send({ type: 'game.resync', gameId: this.game.gameId });
      return null;
    }
    this.resyncing = false;
    this.ackedInputSeq = Math.max(this.ackedInputSeq, snap.ackSeq);
    while (this.unacked[0] && this.unacked[0].seq <= this.ackedInputSeq) this.unacked.shift();
    this.buffer.push(snap, receivedAt);
    this.emitter.emit('snapshot', snap);
    return snap;
  }

  /** @internal */
  handleResults(results: Results): void {
    this.setPhase('ended');
    this.emitter.emit('results', results);
  }

  /** @internal The socket dropped: inputs in flight are lost, the server keeps the last one. */
  handleDisconnect(): void {
    this.unacked = [];
  }

  /** @internal */
  setPhase(phase: RoomConnectionPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitter.emit('phase', phase);
  }
}
