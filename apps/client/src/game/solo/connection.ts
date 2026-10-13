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

export interface SoloOptions {
  /** The player's partner and its upgrades, bindings and bans, from their save. */
  loadout: PlayerConfig;
  /** Pokémon the player owns (a rescued one they own pays coins instead). */
  owned: readonly number[];
  username: string;
  /** Run seed (random by default). */
  seed?: number;
  /** For tests and tools: `fetch` and the worker. */
  fetch?: typeof fetch;
  createWorker?: () => Worker;
}

/** What the server said about a reported solo run (`POST /api/runs`), on top of `Results`. */
export interface SoloReport {
  /** Achievements the run unlocked: `{ id, reward, title }`. */
  achievements: { id: string; reward: Record<string, number>; title: string | null }[];
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
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
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

  async function api(method: string, url: string, body: unknown): Promise<unknown> {
    const res = await doFetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = (data as { error?: { code?: string } } | null)?.error?.code;
      throw new Error(code ?? `HTTP ${res.status}`);
    }
    return data;
  }

  async function report(reason: string, summary: ResultSummary): Promise<void> {
    const id = await (runId ?? Promise.resolve(null));
    const solo: SoloReport = { achievements: [], capped: false, error: null };
    let run: RunSummary = summary.run;
    if (!id) solo.error = 'offline';
    else {
      for (let i = 0; i < REPORT_TRIES; i++) {
        try {
          const r = (await api('POST', '/api/runs', { runId: id, ...summary.run })) as {
            stats?: RunSummary;
            capped?: boolean;
            achievements?: SoloReport['achievements'];
          };
          // What was credited (the server may have capped the claim).
          if (r.stats) run = { ...summary.run, ...r.stats };
          solo.capped = !!r.capped;
          solo.achievements = r.achievements ?? [];
          solo.error = null;
          break;
        } catch (err) {
          solo.error = err instanceof Error ? err.message : String(err);
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
  runId = api('POST', '/api/runs/start', {
    pokemon: { dex: opts.loadout.dex, shiny: !!opts.loadout.shiny },
  })
    .then((r) => (r as { runId?: string }).runId ?? null)
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

/**
 * The solo loadout from the player's save (`GET /api/save` and `/api/auth/me`), as the server
 * builds co-op loadouts (`apps/server/src/game/loadout.ts`).
 */
export async function loadSoloLoadout(
  doFetch: typeof fetch = (...a) => fetch(...a),
): Promise<Pick<SoloOptions, 'loadout' | 'owned' | 'username'>> {
  const get = async (url: string) => {
    const res = await doFetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  };
  const me = (await get('/api/auth/me')) as { user: { id: string; username: string } };
  const save = (await get('/api/save')) as {
    partner: { dex: number | null; shiny: boolean };
    owned: Record<string, unknown>;
    shiny: Record<string, unknown>;
    upgrades: Record<string, Record<string, number>>;
    moveBans: Record<string, string[]>;
    moveBindings: Record<string, (string | null)[]>;
    legendsBeaten: Record<string, unknown>;
  };
  const dex = save.partner.dex;
  if (dex === null || save.owned[String(dex)] === undefined) throw new Error('no partner chosen');
  const key = String(dex);
  return {
    username: me.user.username,
    owned: Object.keys(save.owned).map(Number),
    loadout: {
      id: me.user.id,
      dex,
      shiny: save.partner.shiny && save.shiny[key] !== undefined,
      upgrades: save.upgrades[key] ?? {},
      bannedMoves: save.moveBans[key] ?? [],
      moveBindings: save.moveBindings[key] ?? [],
      legendsBeaten: Object.keys(save.legendsBeaten).map(Number),
    },
  };
}
