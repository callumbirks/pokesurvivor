// The solo connection with the real sim worker, run inline (same thread, messages cloned and
// delivered asynchronously like a Web Worker's), on fake timers: the checkpoint cadence, the
// keep-alive, the local save and what happens to it when the run is reported, refused or offline.
import type { Results } from '@pokesurvivor/netclient';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSoloConnection, type SoloApi, type SoloOptions } from './connection.js';
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
});
