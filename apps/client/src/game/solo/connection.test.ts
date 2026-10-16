// The solo connection with the real sim worker, run inline (same thread, messages cloned and
// delivered asynchronously like a Web Worker's), on fake timers: the checkpoint cadence, the
// keep-alive, the local save and what happens to it when the run is reported, refused or offline.
import type { Results } from '@pokesurvivor/netclient';
import { loadGameData } from '@pokesurvivor/data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoloClock } from '@pokesurvivor/protocol';
import {
  PAUSE_REPORT_DELAY_MS,
  createSoloConnection,
  type SoloApi,
  type SoloOptions,
  type SoloResults,
} from './connection.js';
import type { FromWorker, ToWorker } from './messages.js';
import { memoryRunStore, type SoloRunStore } from './store.js';

interface InlineWorker {
  onmessage: ((ev: { data: FromWorker }) => void) | null;
  onerror: unknown;
  postMessage(m: ToWorker): void;
  terminate(): void;
}

/** A fresh copy of `worker.ts` behind a `Worker`-like object. */
async function inlineWorker(): Promise<InlineWorker> {
  vi.resetModules();
  let alive = true;
  const scope = {
    onmessage: null as ((ev: { data: ToWorker }) => void) | null,
    postMessage(m: FromWorker) {
      const data = structuredClone(m);
      queueMicrotask(() => alive && worker.onmessage?.({ data }));
    },
  };
  const worker: InlineWorker = {
    onmessage: null,
    onerror: null,
    postMessage(m) {
      const data = structuredClone(m);
      queueMicrotask(() => alive && scope.onmessage?.({ data }));
    },
    terminate: () => (alive = false),
  };
  (globalThis as { self?: unknown }).self = scope;
  await import('./worker.js');
  return worker;
}

const loadout = { id: 'u1', dex: 4 };

type Overrides = { [K in keyof SoloApi]?: SoloApi[K] };

function fakeApi(over: Overrides = {}) {
  const report: SoloApi['reportRun'] = (runId, summary) =>
    Promise.resolve({ runId, stats: summary, capped: false, achievements: [], save: {} as never });
  return {
    startRun: vi.fn<SoloApi['startRun']>(
      over.startRun ?? (() => Promise.resolve({ runId: 'run-1', startedAt: '' })),
    ),
    checkpointRun: vi.fn<SoloApi['checkpointRun']>(
      over.checkpointRun ?? (() => Promise.resolve({})),
    ),
    reportRun: vi.fn<SoloApi['reportRun']>(over.reportRun ?? report),
  };
}

async function connect(api: SoloApi, store: SoloRunStore, opts: Partial<SoloOptions> = {}) {
  const worker = await inlineWorker();
  const conn = createSoloConnection({
    loadout,
    owned: [4],
    username: 'ash',
    api,
    store,
    seed: 42,
    invulnerable: true,
    checkpointEveryS: 1,
    createWorker: () => worker as unknown as Worker,
    ...opts,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(conn.phase).toBe('loading');
  conn.loaded();
  await vi.advanceTimersByTimeAsync(0);
  expect(conn.phase).toBe('running');
  return conn;
}

const durations = (api: ReturnType<typeof fakeApi>) =>
  api.checkpointRun.mock.calls.map(([, s]) => s.durationS);

describe('solo connection checkpoints', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checkpoints every interval of run time, saves locally, and clears the save once reported', async () => {
    const api = fakeApi();
    const store = memoryRunStore();
    const conn = await connect(api, store);

    await vi.advanceTimersByTimeAsync(3300);
    expect(durations(api)).toEqual([1, 2, 3]);
    expect(api.checkpointRun.mock.calls.every(([id]) => id === 'run-1')).toBe(true);
    const save = await store.get('u1');
    expect(save).toMatchObject({ runId: 'run-1', seed: 42, loadout, owned: [4] });
    expect(save?.summary.durationS).toBe(3);
    expect(save?.state?.time).toBeGreaterThanOrEqual(3);

    const results = new Promise<Results>((resolve) => conn.on('results', resolve));
    conn.quit();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.reportRun).toHaveBeenCalledTimes(1);
    expect((await results).credited).toBe(true);
    expect(await store.get('u1')).toBeNull();
    conn.close();
  });

  it('saves locally as the run starts and every few seconds, between server checkpoints', async () => {
    const api = fakeApi();
    const store = memoryRunStore();
    const saves: number[] = [];
    const put = store.put.bind(store);
    store.put = (run) => {
      saves.push(run.summary.durationS);
      return put(run);
    };
    const conn = await connect(api, store, { checkpointEveryS: 60, saveEveryS: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([0]);
    await vi.advanceTimersByTimeAsync(4300);
    expect(saves).toEqual([0, 2, 4]);
    // Not reported: the server hears from the run once a minute.
    expect(api.checkpointRun).not.toHaveBeenCalled();
    const saved = await store.get('u1');
    expect(saved?.runId).toBe('run-1');
    expect(saved?.state?.time).toBeGreaterThanOrEqual(4);
    conn.close();
  });

  it('sends keep-alive checkpoints while the run is paused', async () => {
    const api = fakeApi();
    const conn = await connect(api, memoryRunStore(), { checkpointEveryS: 60, keepAliveMs: 1000 });
    conn.setPaused(true);
    await vi.advanceTimersByTimeAsync(3500);
    // The run doesn't advance, but the server keeps hearing from it.
    expect(durations(api).length).toBeGreaterThanOrEqual(2);
    expect(new Set(durations(api))).toEqual(new Set([0]));
    conn.close();
  });

  it('stops checkpointing and drops the save when the server says the run is closed', async () => {
    const refused = Object.assign(new Error('closed'), { code: 'run_credited_by_timeout' });
    const api = fakeApi({ checkpointRun: () => Promise.reject(refused) });
    const store = memoryRunStore();
    const conn = await connect(api, store);
    await vi.advanceTimersByTimeAsync(3300);
    expect(api.checkpointRun).toHaveBeenCalledTimes(1);
    expect(await store.get('u1')).toBeNull();
    conn.close();
  });

  it('keeps checkpointing offline, and keeps the final summary if the report fails', async () => {
    const offline = Object.assign(new Error('offline'), { code: 'network' });
    const api = fakeApi({
      checkpointRun: () => Promise.reject(offline),
      reportRun: () => Promise.reject(offline),
    });
    const store = memoryRunStore();
    const conn = await connect(api, store);
    await vi.advanceTimersByTimeAsync(2300);
    expect(api.checkpointRun).toHaveBeenCalledTimes(2);
    expect((await store.get('u1'))?.summary.durationS).toBe(2);

    const results = new Promise<Results>((resolve) => conn.on('results', resolve));
    conn.quit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await results).credited).toBe(false);
    expect(api.reportRun).toHaveBeenCalledTimes(3);
    // The run is over: only its report is missing ("End run" in the menu sends it).
    const save = await store.get('u1');
    expect(save?.state).toBeNull();
    expect(save?.summary.durationS).toBe(2);
    conn.close();
  });

  it('resumes a saved run on the same run id and keeps checkpointing from where it was', async () => {
    const first = fakeApi();
    const store = memoryRunStore();
    const conn = await connect(first, store);
    await vi.advanceTimersByTimeAsync(2300);
    conn.close(); // The tab is closed.
    const saved = await store.get('u1');
    expect(saved?.summary.durationS).toBe(2);

    const api = fakeApi();
    const resumed = await connect(api, store, { resume: saved!, seed: 1 });
    expect(api.startRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1300);
    expect(durations(api)).toEqual([3]);
    expect(api.checkpointRun.mock.calls[0]?.[0]).toBe('run-1');
    expect((await store.get('u1'))?.seed).toBe(42);

    resumed.quit();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.reportRun.mock.calls[0]?.[0]).toBe('run-1');
    expect(api.reportRun.mock.calls[0]?.[1].durationS).toBe(3);
    expect(await store.get('u1')).toBeNull();
    resumed.close();
  });

  it('plays with the config the server issues, and resumes with it', async () => {
    const data = loadGameData();
    const config = {
      version: 7,
      tuning: {
        ...data.tuning,
        spawner: { ...data.tuning.spawner, cap: data.tuning.spawner.cap + 1 },
      },
      levelup: data.levelUp,
    };
    const first = fakeApi({
      startRun: () => Promise.resolve({ runId: 'run-1', startedAt: '', config }),
    });
    const store = memoryRunStore();
    const conn = await connect(first, store);
    // The game (and so the HUD and texts) gets the run's config; the local save keeps it.
    expect(conn.game?.config).toEqual(config);
    await vi.advanceTimersByTimeAsync(1300);
    conn.close();
    const saved = await store.get('u1');
    expect(saved?.config).toEqual(config);

    // A resume doesn't ask the server again: it plays on with the saved config.
    const api = fakeApi();
    const resumed = await connect(api, store, { resume: saved! });
    expect(api.startRun).not.toHaveBeenCalled();
    expect(resumed.game?.config).toEqual(config);
    resumed.close();
  });

  it("plays with the built-in data when the server can't be reached", async () => {
    const api = fakeApi({ startRun: () => Promise.reject(new Error('offline')) });
    const conn = await connect(api, memoryRunStore());
    expect(conn.game?.config).toBeUndefined();
    conn.close();
  });

  it('checkpoints when the page is hidden or closed', async () => {
    // A minimal page: `document` with a visibility state, and the window's events.
    const page = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
    vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
    try {
      const api = fakeApi();
      const store = memoryRunStore();
      const conn = await connect(api, store, { checkpointEveryS: 60 });
      await vi.advanceTimersByTimeAsync(1500);
      expect(api.checkpointRun).not.toHaveBeenCalled();

      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(durations(api)).toEqual([1]);
      expect((await store.get('u1'))?.summary.durationS).toBe(1);

      // Closing: the latest summary goes out at once, without waiting for the worker (which a
      // reload doesn't leave time for), then a fresh checkpoint if there's time.
      page.dispatchEvent(new Event('pagehide'));
      expect(durations(api)).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.checkpointRun).toHaveBeenCalledTimes(3);
      conn.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** A refusal like the shell's `ApiError` for a run the server credited from its checkpoint. */
  const timedOut = (credited?: object) =>
    Object.assign(new Error('timed out'), {
      code: 'run_credited_by_timeout',
      details: credited ? { credited } : {},
    });
  const credited = { durationS: 1, level: 2, kills: 3, coins: 9 };

  it('ends a run the server credited by timeout while it was away, with what was credited', async () => {
    let calls = 0;
    const api = fakeApi({
      // The tab was frozen past the timeout: the first checkpoint after it is refused.
      checkpointRun: () => (++calls < 2 ? Promise.resolve({}) : Promise.reject(timedOut(credited))),
    });
    const store = memoryRunStore();
    const conn = await connect(api, store);
    const results = new Promise<SoloResults>((resolve) =>
      conn.on('results', (r) => resolve(r as SoloResults)),
    );
    await vi.advanceTimersByTimeAsync(2300);
    const r = await results;
    // The run is over; it isn't reported again, and shows what the server credited.
    expect(api.checkpointRun).toHaveBeenCalledTimes(2);
    expect(api.reportRun).not.toHaveBeenCalled();
    expect(r.credited).toBe(true);
    expect(r.solo).toMatchObject({ timedOut: true, error: null });
    expect(r.players[0]?.summary.run).toMatchObject(credited);
    expect(conn.phase).toBe('ended');
    expect(await store.get('u1')).toBeNull();
    // Nothing more is sent from the ended run.
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.checkpointRun).toHaveBeenCalledTimes(2);
    conn.close();
  });

  it('ends the run with just the message when the refusal has no credited numbers', async () => {
    const api = fakeApi({ checkpointRun: () => Promise.reject(timedOut()) });
    const conn = await connect(api, memoryRunStore());
    const results = new Promise<SoloResults>((resolve) =>
      conn.on('results', (r) => resolve(r as SoloResults)),
    );
    await vi.advanceTimersByTimeAsync(1300);
    const r = await results;
    expect(r.credited).toBe(false);
    expect(r.solo).toMatchObject({ timedOut: true, error: 'run_credited_by_timeout' });
    conn.close();
  });

  it('shows what was credited when the final report finds the run credited by timeout', async () => {
    const api = fakeApi({ reportRun: () => Promise.reject(timedOut(credited)) });
    const store = memoryRunStore();
    const conn = await connect(api, store);
    await vi.advanceTimersByTimeAsync(2300);
    const results = new Promise<SoloResults>((resolve) =>
      conn.on('results', (r) => resolve(r as SoloResults)),
    );
    conn.quit();
    await vi.advanceTimersByTimeAsync(100);
    const r = await results;
    // A refusal isn't retried.
    expect(api.reportRun).toHaveBeenCalledTimes(1);
    expect(r.credited).toBe(true);
    expect(r.solo.timedOut).toBe(true);
    expect(r.players[0]?.summary.run.durationS).toBe(1);
    expect(await store.get('u1')).toBeNull();
    conn.close();
  });
});

describe('solo connection clock (friends presence)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the run clock as it starts, pauses (after a moment) and resumes, then clears it', async () => {
    const clocks: (SoloClock | null)[] = [];
    const conn = await connect(fakeApi(), memoryRunStore(), {
      checkpointEveryS: 0,
      onClock: (c) => clocks.push(c),
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(clocks).toEqual([{ runId: 'run-1', elapsedS: 0, paused: false }]);

    await vi.advanceTimersByTimeAsync(5000);
    conn.setPaused(true);
    // A short pause isn't reported.
    await vi.advanceTimersByTimeAsync(500);
    conn.setPaused(false);
    await vi.advanceTimersByTimeAsync(PAUSE_REPORT_DELAY_MS + 500);
    expect(clocks.slice(1).every((c) => c && !c.paused)).toBe(true);

    conn.setPaused(true);
    await vi.advanceTimersByTimeAsync(PAUSE_REPORT_DELAY_MS + 100);
    const paused = clocks.at(-1);
    expect(paused).toMatchObject({ runId: 'run-1', paused: true });
    expect(paused!.elapsedS).toBeGreaterThan(6);
    expect(paused!.elapsedS).toBeLessThan(10);

    conn.setPaused(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(clocks.at(-1)).toMatchObject({ paused: false, elapsedS: paused!.elapsedS });

    conn.quit();
    await vi.advanceTimersByTimeAsync(100);
    expect(clocks.at(-1)).toBeNull();
    conn.close();
  });
});
