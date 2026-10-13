// A solo run behind the `RoomConnection` interface: the sim runs in a Web Worker (worker.ts) and
// sends the same snapshot frames the game server would, decoded by the same `NetRoomConnection`,
// so the game screen doesn't know the difference. Around the run it talks to the server:
// `POST /api/runs/start` before (the server checks the Pokémon is owned and starts the clock its
// caps use), `POST /api/runs` with the run summary at the end (credited, capped by the server).
// If the server can't be reached the run is still played; its results just aren't credited.
import {
  NetRoomConnection,
  type Game,
  type IntentResult,
  type ResultSummary,
  type Results,
  type RoomConnection,
} from '@pokesurvivor/netclient';
import type { RunSummary } from '@pokesurvivor/protocol';
import type { Intent, PlayerConfig } from '@pokesurvivor/sim';
import type { FromWorker, ToWorker } from './messages.js';

/** The shell's HTTP API for solo runs (its `api.ts` `Api` fits as it is). */
export interface SoloApi {
  /** `POST /api/runs/start`: before the run (the Pokémon must be owned). */
  startRun(pokemon: { dex: number; shiny: boolean }): Promise<{ runId: string; startedAt: string }>;
  /** `POST /api/runs`: the run's summary when it ends; the server caps and credits it. */
  reportRun(runId: string, summary: RunSummary): Promise<RunReport>;
}

/** The server's answer to a reported run (`POST /api/runs`, docs/api.md). */
export interface RunReport {
  runId: string;
  /** What was credited (the claim, capped). */
  stats: unknown;
  capped: boolean;
  achievements: { id: string; reward: unknown; title: string | null }[];
}

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
}

/** What the server said about a reported solo run (`POST /api/runs`), on top of `Results`. */
export interface SoloReport {
  /** Achievements the run unlocked: `{ id, reward, title }`. */
  achievements: RunReport['achievements'];
  /** The server capped the claim (numbers above its per-minute allowances). */
  capped: boolean;
  /** Why the run wasn't credited (offline, refused). */
  error: string | null;
}

export type SoloResults = Results & { solo: SoloReport };

export interface SoloConnection extends RoomConnection {
  setPaused(paused: boolean): void;
  quit(): void;
  /** Stops the worker (when the game screen goes away). */
  close(): void;
}

const REPORT_TRIES = 3;

export function createSoloConnection(opts: SoloOptions): SoloConnection {
  const worker =
    opts.createWorker?.() ??
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'solo-sim' });
  const post = (m: ToWorker) => worker.postMessage(m);
  const now = () => performance.now();
  const pending = new Map<number, (r: IntentResult) => void>();
  let nextRid = 1;
  let game: Game | null = null;
  let runId: Promise<string | null> | null = null;
  let closed = false;

  const conn = new NetRoomConnection(
    opts.loadout.id,
    {
      send(message) {
        if (closed) return false;
        if (message.type === 'input') {
          const m = message;
          post({ type: 'input', seq: m.seq, moveX: m.moveX, moveY: m.moveY, slot: m.slot ?? null });
        } else if (message.type === 'game.loaded') {
          if (!game) return false;
          conn.handleStart(game, false);
          post({ type: 'start' });
        } else if (message.type === 'game.resync') post({ type: 'resync' });
        return true;
      },
      request(message: { type: 'intent'; intent: Intent }) {
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
      case 'ended':
        void report(m.reason, m.summary);
        return;
      case 'error':
        console.error('[solo] worker:', m.message);
        return;
    }
  };
  worker.onerror = (ev) => console.error('[solo] worker failed:', ev.message);

  async function report(reason: string, summary: ResultSummary): Promise<void> {
    const id = await (runId ?? Promise.resolve(null));
    const solo: SoloReport = { achievements: [], capped: false, error: null };
    let run: RunSummary = summary.run;
    if (!id) solo.error = 'offline';
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
          if (solo.error === 'run_already_finished' || solo.error === 'run_not_found') break;
          await new Promise((r) => setTimeout(r, 800 * 2 ** i));
        }
      }
    }
    const results: SoloResults = {
      gameId: game?.gameId ?? 'solo',
      runId: id,
      credited: solo.error === null,
      reason,
      players: [
        {
          userId: opts.loadout.id,
          username: opts.username,
          left: false,
          summary: { run, player: summary.player },
        },
      ],
      solo,
    };
    conn.handleResults(results);
  }

  // Start the run on the server (in parallel with building the sim and loading).
  runId = opts.api
    .startRun({ dex: opts.loadout.dex, shiny: !!opts.loadout.shiny })
    .then((r) => r.runId ?? null)
    .catch((err: unknown) => {
      console.warn('[solo] the run will not be credited:', err);
      return null;
    });
  post({
    type: 'init',
    seed: opts.seed ?? Math.floor(Math.random() * 2 ** 31),
    loadout: opts.loadout,
    username: opts.username,
    owned: [...opts.owned],
  });

  const solo = conn as unknown as SoloConnection;
  solo.setPaused = (paused: boolean) => post({ type: 'pause', paused });
  solo.quit = () => post({ type: 'quit' });
  solo.close = () => {
    closed = true;
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
