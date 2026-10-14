// Client-side prediction and reconciliation for the player's own Pokémon (movement only; the
// server decides everything else). Each frame:
//
//   1. Reconcile from the server snapshot and replay held movement on the server's tick grid.
//      Input timestamps select which movement is held; packet counts never determine elapsed
//      simulation time (the server may apply a packet for several ticks or coalesce several).
//   2. Blend the final predicted tick for smooth movement at any frame rate.
//   3. When a new snapshot changes the answer (the server disagreed: knockback, a trap, a dash, a
//      dropped input), the difference becomes an offset that decays over ~0.1 s instead of a
//      visible snap. Big jumps (teleports to and from the arena) snap at once.
//
// While the game is paused, or the player is down or disconnected, nothing is predicted: the
// server position is used as is.
//
// Guard: if the prediction stays far from the server for over a second (the server isn't applying
// our inputs), we stop predicting and show the server position, with a warning in the console,
// until they agree again. A server-side input problem then looks like rubber-banding instead of
// a ghost walking around while the real Pokémon stands still.
import { TICK_MS, type MovingBody, type WorldView } from '@pokesurvivor/sim';

export interface ServerBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  inLiquid: boolean;
}

export interface PendingInput {
  seq: number;
  moveX: number;
  moveY: number;
  /** When it was sent (the connection's clock, ms). */
  sentAt: number;
}

export interface PredictionFrame {
  server: ServerBody;
  /** The last input seq the server applied (`server` is the state after it). */
  ackSeq: number;
  /** Snapshot simulation tick (also advances during choices). */
  tick: number;
  /** Latest acknowledged movement, which the server holds until changed. */
  ackedInput: PendingInput | null;
  /** Inputs sent but not yet applied by the server, oldest first. */
  unacked: readonly PendingInput[];
  /** Speed before liquids (the snapshot's `self.speed`). */
  speed: number;
  /** The connection's clock now (ms). */
  now: number;
  /** Predict movement (false while paused, down or disconnected). */
  active: boolean;
}

/** Offsets beyond this snap instead of easing (teleports). */
const SNAP_DISTANCE = 96;
/** How fast a correction fades (1/s). */
const CORRECTION_RATE = 12;
/** Prediction this far from the server… */
const DIVERGE_DISTANCE = 48;
/** …for this long means the server isn't applying our inputs. */
const DIVERGE_MS = 1000;

type Mover = Pick<WorldView, 'move'>;

/** Replays `inputs` from `start`, one tick each. Returns the body after each step. */
export function replay(
  world: Mover,
  start: ServerBody,
  inputs: readonly PendingInput[],
  speed: number,
  r: number,
  types: readonly string[],
): MovingBody[] {
  const body: MovingBody = {
    x: start.x,
    y: start.y,
    vx: start.vx,
    vy: start.vy,
    r,
    types: types as MovingBody['types'],
    inLiquid: start.inLiquid,
    walking: false,
    moveAngle: 0,
  };
  const out: MovingBody[] = [];
  for (const i of inputs) {
    world.move(body, i.moveX, i.moveY, speed);
    out.push({ ...body });
  }
  return out;
}

export class Predictor {
  /** Where to draw our Pokémon. */
  x = 0;
  y = 0;
  /** Walking per the prediction (for the animation). */
  walking = false;
  moveAngle = Math.PI / 2;
  /** The correction still being eased out (drawn − predicted). */
  offX = 0;
  offY = 0;
  /** Predicted position after each simulation tick, as of the previous frame. */
  private prev: Map<number, { x: number; y: number }> | null = null;
  private lastNow = 0;
  /** Local start time of server tick 1, estimated from the freshest input acknowledgements. */
  private clockOffset: number | null = null;
  private clockAck = -1;
  /** When the prediction last started disagreeing with the server (null: it agrees). */
  private divergedSince: number | null = null;
  /** Showing the server position until the prediction agrees again. */
  fallback = false;
  /** Each correction's size in world units, teleports excluded (the network stats count them). */
  onCorrection: ((units: number) => void) | null = null;

  constructor(
    private readonly world: Mover,
    private readonly r: number,
    private readonly types: readonly string[],
  ) {}

  /** Forget the history (a new run, or a resume). */
  reset(): void {
    this.prev = null;
    this.clockOffset = null;
    this.clockAck = -1;
    this.offX = this.offY = 0;
    this.divergedSince = null;
    this.fallback = false;
  }

  update(f: PredictionFrame): void {
    const s = f.server;
    // An ack says this input was held by this tick, not that it consumed one tick. The
    // freshest sample gives the least-delayed clock estimate; late packets mustn't move the
    // prediction clock backwards. Repeated acks (including sparse keepalives) don't resample it.
    if (f.ackedInput && f.ackedInput.seq !== this.clockAck) {
      const sample = f.ackedInput.sentAt - (f.tick - 1) * TICK_MS;
      this.clockOffset = this.clockAck < 0 ? sample : Math.max(this.clockOffset ?? sample, sample);
      this.clockAck = f.ackedInput.seq;
    }
    if (this.clockOffset === null && f.unacked[0])
      this.clockOffset = f.unacked[0].sentAt - f.tick * TICK_MS;
    const offset = this.clockOffset ?? f.now - f.tick * TICK_MS;
    // Bound work during a stalled connection. The guard below handles persistent divergence.
    const target = f.active
      ? Math.max(f.tick, Math.min(f.tick + 30, (f.now - offset) / TICK_MS))
      : f.tick;
    const after = new Map<number, { x: number; y: number }>([[f.tick, { x: s.x, y: s.y }]]);
    let held = f.ackedInput;
    let cursor = 0;
    const inputs: PendingInput[] = [];
    for (let tick = f.tick + 1; tick <= Math.ceil(target); tick++) {
      const startsAt = offset + (tick - 1) * TICK_MS;
      while (f.unacked[cursor] && f.unacked[cursor]!.sentAt <= startsAt + 0.001)
        held = f.unacked[cursor++]!;
      inputs.push(held ?? { seq: 0, moveX: 0, moveY: 0, sentAt: startsAt });
    }
    const steps = replay(this.world, s, inputs, f.speed, this.r, this.types);
    steps.forEach((b, i) => after.set(f.tick + i + 1, { x: b.x, y: b.y }));

    // A correction: the newest simulation tick both this frame and the last one predicted, landing
    // somewhere else now. The difference is eased out instead of jumping.
    const dt = this.prev ? Math.max(0, Math.min(0.25, (f.now - this.lastNow) / 1000)) : 0;
    if (this.prev) {
      let seq = -1;
      for (const k of after.keys()) if (k > seq && this.prev.has(k)) seq = k;
      const a = this.prev.get(seq);
      const b = after.get(seq);
      if (a && b) {
        this.offX += a.x - b.x;
        this.offY += a.y - b.y;
        const units = Math.hypot(a.x - b.x, a.y - b.y);
        if (units > 0 && units <= SNAP_DISTANCE) this.onCorrection?.(units);
      }
    }
    if (Math.hypot(this.offX, this.offY) > SNAP_DISTANCE) this.offX = this.offY = 0;
    const decay = Math.exp(-CORRECTION_RATE * dt);
    this.offX *= decay;
    this.offY *= decay;
    this.prev = after;
    this.lastNow = f.now;

    // The newest input is being applied during this tick: blend across it.
    let x = s.x;
    let y = s.y;
    let walking = false;
    const last = steps[steps.length - 1];
    if (last) {
      const before = steps.length > 1 ? steps[steps.length - 2]! : s;
      const k = target - Math.ceil(target) + 1;
      x = before.x + (last.x - before.x) * k;
      y = before.y + (last.y - before.y) * k;
      walking = last.walking;
      if (walking) this.moveAngle = last.moveAngle;
    }
    if (!f.active) this.offX = this.offY = 0;
    this.x = x + this.offX;
    this.y = y + this.offY;
    this.walking = walking;
    this.guard(f, x, y);
  }

  private guard(f: PredictionFrame, x: number, y: number): void {
    const s = f.server;
    if (!f.active || Math.hypot(x - s.x, y - s.y) <= DIVERGE_DISTANCE) {
      this.divergedSince = null;
      this.fallback = false;
      return;
    }
    this.divergedSince ??= f.now;
    if (!this.fallback && f.now - this.divergedSince > DIVERGE_MS) {
      this.fallback = true;
      console.warn(
        `prediction: ${Math.round(Math.hypot(x - s.x, y - s.y))} units from the server for over ` +
          `${DIVERGE_MS} ms (ack ${f.ackSeq}, ${f.unacked.length} unacked inputs); showing the server position`,
      );
    }
    if (this.fallback) {
      this.x = s.x;
      this.y = s.y;
      this.offX = this.offY = 0;
    }
  }
}
