// A solo run behind the `RoomConnection` interface: the sim runs in a Web Worker (worker.ts) and
// sends the same snapshot frames the game server would, decoded by the same `NetRoomConnection`,
// so the game screen doesn't know the difference. Around the run it talks to the server:
// `POST /api/runs/start` before (the server checks the Pokémon is owned and starts the clock its
// caps use), `POST /api/runs/checkpoint` with the run so far about every minute of run time
// (stored, credited by the server only if the final report never comes), and `POST /api/runs`
// with the run summary at the end (credited, capped by the server). At each checkpoint it also
// saves the sim's state locally (`SoloRunStore`), so a closed tab can resume or report the run.
// If the server can't be reached the run is still played; its results just aren't credited.
import {
  NetRoomConnection,
  type Game,
  type IntentResult,
  type ResultSummary,
  type Results,
  type RoomConnection,
} from '@pokesurvivor/netclient';
import type { RunSummary, SoloClock } from '@pokesurvivor/protocol';
import type { Intent, PlayerConfig } from '@pokesurvivor/sim';
import type { RunReport } from '../../app/api.js';
import { loadFailed } from '../../load-recovery.js';
import type { DevAction, FromWorker, ToWorker } from './messages.js';
import type { SavedSoloRun, SoloRunStore } from './store.js';

/**
 * The server side of a solo run, bound to the player's session and partner by the shell
 * (`docs/api.md`, Runs): `startRun` before the run starts (the server caps the results by the time
 * since then), `checkpointRun` with the run so far while it plays, `reportRun` as soon as the sim
 * ends; the connection then emits `results` with what was credited.
 */
export interface SoloApi {
  startRun(): Promise<{ runId: string; startedAt: string }>;
  checkpointRun(runId: string, summary: RunSummary): Promise<unknown>;
  reportRun(runId: string, summary: RunSummary): Promise<RunReport>;
}

/** Run time between checkpoints reported to the server. */
export const CHECKPOINT_EVERY_S = 60;
/**
 * Run time between local saves (also one as the run starts). Much more often than the server
 * checkpoints: a reload or a closed tab can't wait for the worker, so it resumes from the last
 * of these.
 */
export const SAVE_EVERY_S = 5;
/**
 * Wall-clock time after which an open run sends a checkpoint anyway (paused, or waiting on a
 * choice), well inside the server's timeout (`RUN_CHECKPOINT_TIMEOUT_S`, an hour by default).
 */
export const KEEP_ALIVE_MS = 3 * 60_000;

/** Server refusals that mean the run is closed: it won't be credited (again), don't retry. */
const RUN_CLOSED = new Set(['run_already_finished', 'run_credited_by_timeout', 'run_not_found']);
export const isRunClosed = (code: string): boolean => RUN_CLOSED.has(code);

export interface SoloOptions {
  /** The player's partner and its upgrades, bindings and bans, from their save. */
  loadout: PlayerConfig;
  /** Pokémon the player owns (a rescued one they own pays coins instead). */
  owned: readonly number[];
  username: string;
  /** Starts and reports the run on the server. */
  api: SoloApi;
  /** Run seed (random by default). */
  seed?: number;
  /** For tests and tools: the sim's worker. */
  createWorker?: () => Worker;
  /** Dev and perf tests only: start this many minutes into a run (cards picked for you). */
  skipMinutes?: number;
  /** Dev and perf tests only: the player can't be hurt. */
  invulnerable?: boolean;
  /** Dev page only: replace the player's moves (one slot each). */
  devMoves?: string[];
  devMoveLevel?: number;
  /**
   * Continue a locally saved run (its `state`) on the same `runId` instead of starting one; its
   * seed, loadout and `owned` are used. The shell checks with the server first that it's open.
   */
  resume?: SavedSoloRun;
  /** Where checkpoints are saved for a resume (none: not saved). */
  store?: SoloRunStore;
  /** Run time between checkpoints (`CHECKPOINT_EVERY_S`; 0 for none). */
  checkpointEveryS?: number;
  /** Run time between local saves (`SAVE_EVERY_S`; 0 for none but the checkpoints). */
  saveEveryS?: number;
  /** Keep-alive checkpoints while the run doesn't advance (`KEEP_ALIVE_MS`). */
  keepAliveMs?: number;
  /**
   * The run's clock for friends' presence (`NetClient.setSoloClock`): as it starts, pauses and
   * resumes, and at checkpoints; null once it's over. Pauses are reported after
   * `PAUSE_REPORT_DELAY_MS`, so picking a card doesn't flicker on friends' screens.
   */
  onClock?: (clock: SoloClock | null) => void;
}

/** A pause shorter than this isn't reported to friends (the server corrects any drift). */
export const PAUSE_REPORT_DELAY_MS = 2000;

/** What the server said about a reported solo run (`POST /api/runs`), on top of `Results`. */
export interface SoloReport {
  /** Achievements the run unlocked: `{ id, reward, title }`. */
  achievements: RunReport['achievements'];
  /** The server capped the claim (numbers above its per-minute allowances). */
  capped: boolean;
  /** Why the run wasn't credited (offline, refused). */
  error: string | null;
  /**
   * The server had already credited the run from its last checkpoint (it was away longer than
   * the server's timeout): the results are what was credited then.
   */
  timedOut: boolean;
}

export type SoloResults = Results & { solo: SoloReport };

export interface SoloConnection extends RoomConnection {
  setPaused(paused: boolean): void;
  quit(): void;
  /** Stops the worker (when the game screen goes away). */
  close(): void;
  /** Dev page only: trigger a rift, the arena, an event or weather. */
  devTrigger(action: DevAction): void;
}

const REPORT_TRIES = 3;

export function createSoloConnection(opts: SoloOptions): SoloConnection {
  const resume = opts.resume?.state ? opts.resume : undefined;
  const loadout = resume?.loadout ?? opts.loadout;
  const owned = resume?.owned ?? [...opts.owned];
  const seed = resume?.seed ?? opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const keepAliveMs = opts.keepAliveMs ?? KEEP_ALIVE_MS;
  const worker =
    opts.createWorker?.() ??
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'solo-sim' });
  /** The worker has said something: it loaded. */
  let heard = false;
  const post = (m: ToWorker) => worker.postMessage(m);
  const now = () => performance.now();
  const pending = new Map<number, (r: IntentResult) => void>();
  let nextRid = 1;
  let game: Game | null = null;
  let runId: Promise<string | null> | null = null;
  let closed = false;
  let ended = false;
  /**
   * The server refused a checkpoint because the run is closed there (e.g. credited by timeout
   * while the tab was in the background): the run is ended with that refusal as its result.
   */
  let closedBy: unknown = null;
  let lastCheckpoint = now();
  let clockTimer: ReturnType<typeof setTimeout> | null = null;
  let clockShown = false;
  /** The run id once known, and the latest run summary: sent as the page goes away. */
  let knownRunId: string | null = null;
  let latestSummary: RunSummary | null = null;
  // Store writes in order, so a late checkpoint save can't bring back a save the report cleared.
  let storeQueue: Promise<void> = Promise.resolve();
  const storeOp = (op: (store: SoloRunStore) => Promise<void>) => {
    const store = opts.store;
    if (!store) return storeQueue;
    storeQueue = storeQueue
      .then(() => op(store))
      .catch((err: unknown) => console.warn('[solo] local save failed:', err));
    return storeQueue;
  };
  const saved = (id: string, summary: RunSummary, state: SavedSoloRun['state']): SavedSoloRun => ({
    userId: loadout.id,
    runId: id,
    savedAt: Date.now(),
    seed,
    loadout,
    username: opts.username,
    owned,
    summary,
    state,
  });

  const conn = new NetRoomConnection(
    loadout.id,
    {
      send(message) {
        if (closed) return false;
        if (message.type === 'input') {
          const m = message;
          post({
            type: 'input',
            seq: m.seq,
            moveX: m.moveX,
            moveY: m.moveY,
            slot: m.slot ?? null,
            aim: m.aim ?? null,
            fire: m.fire === true,
          });
        } else if (message.type === 'game.loaded') {
          if (!game) return false;
          conn.handleStart(game, false);
          post({ type: 'start' });
        } else if (message.type === 'game.resync') post({ type: 'resync' });
        return true;
      },
      // One game per worker: `gameId` needs no check here.
      request(message: { type: 'intent'; gameId: string; intent: Intent }) {
        return new Promise((resolve, reject) => {
          const rid = nextRid++;
          pending.set(rid, (r) => (r.ok ? resolve(undefined) : reject(new Error(r.error))));
          post({ type: 'intent', rid, intent: message.intent });
        });
      },
      now,
    },
    // No network jitter: a short delay is enough to interpolate between 30 Hz frames.
    { delayMs: 50 },
  );

  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    heard = true;
    const m = ev.data;
    switch (m.type) {
      case 'ready':
        game = m.game;
        conn.handleLoading(m.game);
        return;
      case 'frame':
        conn.handleFrame(m.data, now());
        return;
      case 'reply':
        pending.get(m.rid)?.(m.result);
        pending.delete(m.rid);
        return;
      case 'checkpoint':
        if (m.report) lastCheckpoint = now();
        void checkpoint(m.summary, m.state, m.report);
        return;
      case 'clock':
        reportClock(m.elapsedS, m.paused);
        return;
      case 'ended':
        ended = true;
        clearClock();
        void report(m.reason, m.summary);
        return;
      case 'error':
        console.error('[solo] worker:', m.message);
        return;
    }
  };
  worker.onerror = (ev: ErrorEvent | Event) => {
    // A script that failed to load (e.g. a tab from before a deploy asking for its old worker)
    // gets a plain error event; an exception inside the worker comes with a message.
    if (!heard && !(ev as Partial<ErrorEvent>).message && !opts.createWorker) loadFailed();
    else console.error('[solo] worker failed:', (ev as Partial<ErrorEvent>).message);
  };

  async function checkpoint(
    summary: RunSummary,
    state: SavedSoloRun['state'],
    report: boolean,
  ): Promise<void> {
    const id = await (runId ?? Promise.resolve(null));
    if (!id || closedBy || ended) return;
    latestSummary = summary;
    void storeOp((store) => store.put(saved(id, summary, state)));
    if (!report) return;
    try {
      await opts.api.checkpointRun(id, summary);
    } catch (err) {
      // Offline: the local save and the next checkpoint cover it. Closed: the run can't be
      // credited any more, so don't let it go on: end it now, with the refusal as its result.
      if (!isRunClosed(errorCode(err)) || closedBy || ended) return;
      closedBy = err;
      void storeOp((store) => store.delete(loadout.id, id));
      post({ type: 'quit' });
    }
  }

  function reportClock(elapsedS: number, paused: boolean): void {
    if (!opts.onClock) return;
    if (clockTimer !== null) clearTimeout(clockTimer);
    clockTimer = null;
    const send = () => {
      void (runId ?? Promise.resolve(null)).then((id) => {
        if (!id || closed || ended || closedBy) return;
        clockShown = true;
        opts.onClock?.({ runId: id, elapsedS, paused });
      });
    };
    if (paused) clockTimer = setTimeout(send, PAUSE_REPORT_DELAY_MS);
    else send();
  }

  /** The run is over (or the screen gone): friends see the menus again. */
  function clearClock(): void {
    if (clockTimer !== null) clearTimeout(clockTimer);
    clockTimer = null;
    if (clockShown) opts.onClock?.(null);
    clockShown = false;
  }

  /** Asks the worker for a checkpoint now (keep-alive, page hidden or closing). */
  function requestCheckpoint(): void {
    if (!closed && !ended && !closedBy && conn.phase === 'running') post({ type: 'checkpoint' });
  }

  /**
   * The page is going away (reload, closed tab, navigation): there's no time for the worker to
   * answer, so report the latest summary (from the last local save) right now, with `keepalive`.
   */
  function onPageHide(): void {
    if (closed || ended || closedBy || !knownRunId || !latestSummary) return;
    opts.api.checkpointRun(knownRunId, latestSummary).catch(() => {});
    requestCheckpoint();
  }

  /** The run is closed on the server: what the refusal says was credited, if anything. */
  function closedResult(err: unknown, solo: SoloReport, run: RunSummary): RunSummary {
    solo.error = errorCode(err);
    const credited = (err as { details?: { credited?: unknown } } | null)?.details?.credited;
    if (solo.error !== 'run_credited_by_timeout') return run;
    solo.timedOut = true;
    if (!isRunSummary(credited)) return run;
    solo.error = null;
    return { ...run, ...credited };
  }

  async function report(reason: string, summary: ResultSummary): Promise<void> {
    const id = await (runId ?? Promise.resolve(null));
    const solo: SoloReport = { achievements: [], capped: false, error: null, timedOut: false };
    let run: RunSummary = summary.run;
    if (!id) solo.error = 'offline';
    else if (closedBy) run = closedResult(closedBy, solo, run);
    else {
      for (let i = 0; i < REPORT_TRIES; i++) {
        try {
          const r = await opts.api.reportRun(id, summary.run);
          // What was credited (the server may have capped the claim).
          if (isRunSummary(r.stats)) run = { ...summary.run, ...r.stats };
          solo.capped = !!r.capped;
          solo.achievements = r.achievements ?? [];
          solo.error = null;
          break;
        } catch (err) {
          solo.error = errorCode(err);
          // Refusals won't change on retry; network errors might.
          if (isRunClosed(solo.error)) {
            run = closedResult(err, solo, run);
            break;
          }
          await new Promise((r) => setTimeout(r, 800 * 2 ** i));
        }
      }
      // Credited or refused: nothing left to resume. Unreachable: keep the final summary, so
      // the menu can report it later ("End run").
      if (solo.error === null || solo.timedOut || isRunClosed(solo.error))
        void storeOp((store) => store.delete(loadout.id, id));
      else void storeOp((store) => store.put(saved(id, summary.run, null)));
    }
    const results: SoloResults = {
      gameId: game?.gameId ?? 'solo',
      runId: id,
      credited: solo.error === null,
      reason,
      players: [
        {
          userId: loadout.id,
          username: opts.username,
          left: false,
          summary: { run, player: summary.player },
        },
      ],
      solo,
    };
    conn.handleResults(results);
  }

  // Start the run on the server (in parallel with building the sim and loading), or continue
  // the saved one.
  if (resume) knownRunId = resume.runId;
  runId = resume
    ? Promise.resolve(resume.runId)
    : opts.api
        .startRun()
        .then((r) => (knownRunId = r.runId ?? null))
        .catch((err: unknown) => {
          console.warn('[solo] the run will not be credited:', err);
          return null;
        });
  post({
    type: 'init',
    seed,
    loadout,
    username: opts.username,
    owned,
    skipMinutes: opts.skipMinutes,
    invulnerable: opts.invulnerable,
    devMoves: opts.devMoves,
    devMoveLevel: opts.devMoveLevel,
    restore: resume?.state ?? undefined,
    checkpointEveryS: opts.checkpointEveryS ?? CHECKPOINT_EVERY_S,
    saveEveryS: opts.saveEveryS ?? SAVE_EVERY_S,
  });

  // Keep-alive: an open run that doesn't advance (paused, choosing) still checkpoints.
  const keepAlive = setInterval(
    () => {
      if (now() - lastCheckpoint >= keepAliveMs) requestCheckpoint();
    },
    Math.min(keepAliveMs, 30_000),
  );
  // Hidden (a phone switching apps freezes the tab, timers and worker included): checkpoint and
  // save now; the game screen pauses a hidden solo run too. Closing: see `onPageHide`.
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') requestCheckpoint();
  };
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) {
    document.addEventListener('visibilitychange', onVisibility);
    addEventListener('pagehide', onPageHide);
  }

  const solo = conn as unknown as SoloConnection;
  solo.setPaused = (paused: boolean) => post({ type: 'pause', paused });
  solo.quit = () => post({ type: 'quit' });
  solo.devTrigger = (action) => post({ type: 'debug', action });
  solo.close = () => {
    clearClock();
    closed = true;
    clearInterval(keepAlive);
    if (hasDocument) {
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('pagehide', onPageHide);
    }
    worker.terminate();
    for (const resolve of pending.values()) resolve({ ok: false, error: 'closed' });
    pending.clear();
  };
  return solo;
}

/** Was this run started by `createSoloConnection` (results carry the server's report)? */
export function isSoloResults(r: Results): r is SoloResults {
  return 'solo' in r;
}

function isRunSummary(v: unknown): v is RunSummary {
  return !!v && typeof v === 'object' && typeof (v as RunSummary).durationS === 'number';
}

/** An API error's stable code (the shell's `ApiError.code`), or its message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message : String(err);
}
