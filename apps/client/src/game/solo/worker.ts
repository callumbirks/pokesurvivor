// The solo run's simulation, in a Web Worker: the same sim the server runs for co-op rooms, stepped
// at 30 Hz and projected into the same binary snapshots (`SnapshotEncoder`), so the game client
// can't tell solo from the network. Choices have no deadline (the game simply waits). It sends
// checkpoints: the run so far and a copy of the state (plain JSON data). The connection saves every
// one locally, so the run can be resumed, and reports those marked `report` to the server: one
// as the run starts and every `saveEveryS` of run time (saved only), every `checkpointEveryS`
// (saved and reported), and on request.
import { SnapshotEncoder, firstOption } from '@pokesurvivor/netclient';
import { loadGameData } from '@pokesurvivor/data';
import { decodeAim } from '@pokesurvivor/protocol';
import {
  TICK_HZ,
  TICK_MS,
  createSim,
  drainTicks,
  moveStatsAt,
  restoreSim,
  type Sim,
} from '@pokesurvivor/sim';
import type { FromWorker, ToWorker } from './messages.js';

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as WorkerScope;

const WEATHERS = ['sun', 'rain', 'sand', 'snow', 'fog'] as const;
let weatherIdx = 0;

/** At most this much lag is caught up at once (a stalled tab doesn't fast-forward the run). */
const MAX_CATCH_UP_MS = 250;

let sim: Sim | null = null;
let encoder: SnapshotEncoder | null = null;
let playerId = '';
let owned = new Set<number>();
let input = {
  seq: 0,
  moveX: 0,
  moveY: 0,
  slot: null as number | null,
  aim: null as number | null,
  fire: false,
};
let running = false;
let paused = false;
let ended = false;
let seq = 0;
let acc = 0;
let last = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let checkpointEveryS = 0;
let saveEveryS = 0;
let nextCheckpointS = Infinity;
let nextSaveS = Infinity;
/** Whether the run's clock was last reported stopped (null: not reported yet). */
let clockStopped: boolean | null = null;

const post = (m: FromWorker, transfer?: Transferable[]) => scope.postMessage(m, transfer);

function sendFrame(events: ReturnType<Sim['drainEvents']>): void {
  if (!sim || !encoder) return;
  const data = encoder.encode(sim.state, events, ++seq, input.seq) as Uint8Array;
  post({ type: 'frame', data }, [data.buffer]);
}

/**
 * Reports the run time and whether it's standing still (paused, or waiting on a choice) when
 * that changes, or always with `force` (for friends' presence; see `SoloOptions.onClock`).
 */
function clock(force = false): void {
  if (!sim || !running || ended) return;
  const stopped = paused || sim.paused;
  if (!force && stopped === clockStopped) return;
  clockStopped = stopped;
  post({ type: 'clock', elapsedS: sim.state.time, paused: stopped });
}

function checkpoint(report: boolean): void {
  if (!sim || ended) return;
  if (report) clock(true);
  const s = sim;
  const run = s.runSummaryFor(playerId, (dex) => owned.has(dex));
  // `postMessage` copies the state (structured clone) before the next tick changes it.
  post({ type: 'checkpoint', summary: run, state: s.state, report });
  scheduleCheckpoints(s);
}

/** The next multiple of `every` seconds of run time (never if `every` is 0). */
const nextMultiple = (time: number, every: number) =>
  every > 0 ? (Math.floor(time / every) + 1) * every : Infinity;

function scheduleCheckpoints(s: Sim): void {
  nextCheckpointS = nextMultiple(s.state.time, checkpointEveryS);
  nextSaveS = nextMultiple(s.state.time, saveEveryS);
}

function finish(reason: string): void {
  if (!sim || ended) return;
  ended = true;
  running = false;
  if (timer !== null) clearInterval(timer);
  const owns = (dex: number) => owned.has(dex);
  const run = sim.runSummaryFor(playerId, owns);
  const player = sim
    .summary((_, dex) => owned.has(dex))
    .players.find((p) => p.playerId === playerId);
  post({ type: 'ended', reason, summary: { run, player: player ?? null } });
}

function loop(): void {
  if (!sim || !running) return;
  const now = performance.now();
  const elapsed = Math.min(MAX_CATCH_UP_MS, now - last);
  last = now;
  if (paused) return;
  const { ticks, remainderMs } = drainTicks(acc + elapsed);
  acc = remainderMs;
  for (let i = 0; i < ticks && !ended; i++) {
    sim.setInput(playerId, {
      moveX: input.moveX,
      moveY: input.moveY,
      slot: input.slot,
      aim: input.aim === null ? null : decodeAim(input.aim),
      fire: input.fire,
    });
    input.slot = null;
    sim.step();
    // Every tick: solo has no bandwidth to save, and it keeps interpolation smooth.
    sendFrame(sim.drainEvents());
    if (sim.ended) finish(sim.state.ended?.reason ?? 'all-down');
    else if (sim.state.time >= nextCheckpointS) checkpoint(true);
    else if (sim.state.time >= nextSaveS) checkpoint(false);
  }
  clock();
}

/** Dev and perf tests: plays the first minutes for you (circling, invulnerable, first cards). */
function setDevMoves(s: Sim, ids: string[], level: number): void {
  const p = s.state.players[0];
  const data = loadGameData();
  const moves = ids.filter((id) => data.moveById.has(id)).slice(0, 4);
  if (!p || !moves.length) return;
  p.moves = moves.map((id) => {
    const def = data.moveById.get(id)!;
    const stats = moveStatsAt(id, level, false);
    return { id, kind: def.kind, type: def.type, level, evolved: false, stats, t: 0, castTick: -1 };
  });
  p.slots = moves.map((id) => [id]);
  p.maxSlots = Math.max(p.maxSlots, moves.length);
  p.active = 0;
}

function skipAhead(s: Sim, seconds: number): void {
  const cfg = s.state.config;
  while (s.state.time < seconds && !s.ended) {
    for (const c of s.state.pendingChoices.slice()) {
      const intent = firstOption(c);
      if (intent) s.submitIntent(c.playerId, intent);
    }
    const a = s.state.tick / 200;
    s.setInput(playerId, { moveX: Math.cos(a), moveY: Math.sin(a) });
    const god = cfg.invulnerable;
    cfg.invulnerable = true;
    s.step();
    cfg.invulnerable = god;
    s.drainEvents();
  }
  s.setInput(playerId, { moveX: 0, moveY: 0 });
}

scope.onmessage = (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init': {
        playerId = m.loadout.id;
        owned = new Set(m.owned);
        sim = m.restore
          ? restoreSim(m.restore)
          : createSim({
              seed: m.seed,
              players: [m.loadout],
              choiceTimeoutSeconds: null,
              debug: m.invulnerable ? { invulnerable: true } : undefined,
            });
        encoder = new SnapshotEncoder({ viewerId: playerId });
        if (m.skipMinutes && !m.restore) skipAhead(sim, m.skipMinutes * 60);
        if (m.devMoves?.length && !m.restore) setDevMoves(sim, m.devMoves, m.devMoveLevel ?? 1);
        checkpointEveryS = m.checkpointEveryS ?? 0;
        saveEveryS = m.saveEveryS ?? 0;
        scheduleCheckpoints(sim);
        const p = sim.state.players[0]!;
        post({
          type: 'ready',
          game: {
            roomId: 'solo',
            gameId: `solo-${m.seed}`,
            seed: m.seed,
            tickHz: TICK_HZ,
            snapshotHz: TICK_HZ,
            choiceTimeoutS: null,
            roster: sim.state.roster,
            players: [
              {
                id: playerId,
                username: m.username,
                index: 0,
                dex: p.dex,
                shiny: p.shiny,
                ...(m.loadout.prestige ? { prestige: m.loadout.prestige } : {}),
              },
            ],
          },
        });
        return;
      }
      case 'start':
        if (!sim || running || ended) return;
        running = true;
        last = performance.now();
        sendFrame([]);
        timer = setInterval(loop, TICK_MS / 2);
        clock(true);
        // Saved from the start: a reload in the first seconds can resume the run too.
        if (saveEveryS > 0) checkpoint(false);
        return;
      case 'input':
        if (m.seq <= input.seq) return;
        input = {
          seq: m.seq,
          moveX: m.moveX,
          moveY: m.moveY,
          slot: m.slot ?? input.slot,
          aim: m.aim,
          fire: m.fire,
        };
        return;
      case 'intent': {
        const result = sim
          ? sim.submitIntent(playerId, m.intent)
          : { ok: false as const, error: 'no run' };
        post({ type: 'reply', rid: m.rid, result });
        // A pick unpauses the run on the next tick; send the change right away anyway.
        if (sim && running && result.ok) sendFrame(sim.drainEvents());
        return;
      }
      case 'pause':
        paused = m.paused;
        last = performance.now();
        clock();
        return;
      case 'resync':
        encoder?.reset();
        if (sim && running) sendFrame([]);
        return;
      case 'debug': {
        if (!sim) return;
        const a = m.action;
        if (a === 'rift') sim.debugOpenRift();
        else if (a === 'arena') sim.debugStartArena();
        else if (a === 'weather')
          sim.debugStartWeather(WEATHERS[weatherIdx++ % WEATHERS.length]!, 40);
        else if (a === 'momentum') sim.debugMaxMomentum(playerId);
        else sim.debugStartEvent(a);
        return;
      }
      case 'checkpoint':
        if (running) checkpoint(true);
        return;
      case 'quit':
        if (!sim || ended) return;
        sim.removePlayer(playerId);
        sendFrame(sim.drainEvents());
        finish('quit');
        return;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
