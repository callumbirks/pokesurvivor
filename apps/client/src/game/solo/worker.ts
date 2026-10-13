// The solo run's simulation, in a Web Worker: the same sim the server runs for co-op rooms, stepped
// at 30 Hz and projected into the same binary snapshots (`SnapshotEncoder`), so the game client
// can't tell solo from the network. Choices have no deadline (the game simply waits). Every
// `checkpointEveryS` of run time it sends a checkpoint: the run so far and a copy of the state
// (plain JSON data), which the connection reports and saves so the run can be resumed.
import { SnapshotEncoder, firstOption } from '@pokesurvivor/netclient';
import { TICK_HZ, TICK_MS, createSim, drainTicks, restoreSim, type Sim } from '@pokesurvivor/sim';
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
let input = { seq: 0, moveX: 0, moveY: 0, slot: null as number | null };
let running = false;
let paused = false;
let ended = false;
let seq = 0;
let acc = 0;
let last = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let checkpointEveryS = 0;
let nextCheckpointS = Infinity;

const post = (m: FromWorker, transfer?: Transferable[]) => scope.postMessage(m, transfer);

function sendFrame(events: ReturnType<Sim['drainEvents']>): void {
  if (!sim || !encoder) return;
  const data = encoder.encode(sim.state, events, ++seq, input.seq) as Uint8Array;
  post({ type: 'frame', data }, [data.buffer]);
}

function checkpoint(): void {
  if (!sim || ended) return;
  const s = sim;
  const run = s.runSummaryFor(playerId, (dex) => owned.has(dex));
  // `postMessage` copies the state (structured clone) before the next tick changes it.
  post({ type: 'checkpoint', summary: run, state: s.state });
  scheduleCheckpoint(s);
}

/** The next checkpoint is due at the next multiple of `checkpointEveryS` of run time. */
function scheduleCheckpoint(s: Sim): void {
  nextCheckpointS =
    checkpointEveryS > 0
      ? (Math.floor(s.state.time / checkpointEveryS) + 1) * checkpointEveryS
      : Infinity;
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
    sim.setInput(playerId, { moveX: input.moveX, moveY: input.moveY, slot: input.slot });
    input.slot = null;
    sim.step();
    // Every tick: solo has no bandwidth to save, and it keeps interpolation smooth.
    sendFrame(sim.drainEvents());
    if (sim.ended) finish(sim.state.ended?.reason ?? 'all-down');
    else if (sim.state.time >= nextCheckpointS) checkpoint();
  }
}

/** Dev and perf tests: plays the first minutes for you (circling, invulnerable, first cards). */
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
        checkpointEveryS = m.checkpointEveryS ?? 0;
        scheduleCheckpoint(sim);
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
            players: [{ id: playerId, username: m.username, index: 0, dex: p.dex, shiny: p.shiny }],
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
        return;
      case 'input':
        if (m.seq <= input.seq) return;
        input = { seq: m.seq, moveX: m.moveX, moveY: m.moveY, slot: m.slot ?? input.slot };
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
        else sim.debugStartEvent(a);
        return;
      }
      case 'checkpoint':
        if (running) checkpoint();
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
