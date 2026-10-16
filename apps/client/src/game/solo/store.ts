// The local save of an unfinished solo run (IndexedDB), written at each checkpoint, so a closed
// tab, a crash or a reload can resume the run or report it (see `SavedSoloRun`). One per user:
// a new run replaces an older save (the server still credits that one from its checkpoint).
import type { RunConfigWire, RunSummary } from '@pokesurvivor/protocol';
import type { PlayerConfig, SimState } from '@pokesurvivor/sim';

export interface SavedSoloRun {
  userId: string;
  runId: string;
  /** `Date.now()` when saved. */
  savedAt: number;
  seed: number;
  loadout: PlayerConfig;
  username: string;
  owned: number[];
  /**
   * The live-tuning config the server issued the run: a resume plays on with it. Absent in saves
   * from before live tuning (the built-in data).
   */
  config?: RunConfigWire;
  /** The run so far: what "End run" reports. */
  summary: RunSummary;
  /**
   * The sim at the checkpoint, to resume from; null once the run has ended and only its report
   * is missing (the server couldn't be reached).
   */
  state: SimState | null;
}

export interface SoloRunStore {
  get(userId: string): Promise<SavedSoloRun | null>;
  put(run: SavedSoloRun): Promise<void>;
  /** Deletes the user's save if it is of this run (a newer run's save is kept). */
  delete(userId: string, runId: string): Promise<void>;
}

const DB_NAME = 'pokesurvivor';
const STORE = 'solo-runs';

/** The store in IndexedDB (`factory` for tests). */
export function indexedDbRunStore(factory: IDBFactory = indexedDB): SoloRunStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'userId' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null;
        reject(req.error ?? new Error('IndexedDB open failed'));
      };
    }));
  const tx = async <T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    async get(userId) {
      const run = await tx<SavedSoloRun | undefined>('readonly', (s) => s.get(userId));
      return run ?? null;
    },
    async put(run) {
      await tx('readwrite', (s) => s.put(run));
    },
    async delete(userId, runId) {
      await tx('readwrite', (s) => {
        const req = s.get(userId);
        req.onsuccess = () => {
          if ((req.result as SavedSoloRun | undefined)?.runId === runId) s.delete(userId);
        };
      });
    },
  };
}

/** A store in memory (tests, and browsers without IndexedDB: nothing survives a reload). */
export function memoryRunStore(): SoloRunStore {
  const runs = new Map<string, SavedSoloRun>();
  return {
    get: (userId) => Promise.resolve(structuredClone(runs.get(userId) ?? null)),
    put: (run) => {
      runs.set(run.userId, structuredClone(run));
      return Promise.resolve();
    },
    delete: (userId, runId) => {
      if (runs.get(userId)?.runId === runId) runs.delete(userId);
      return Promise.resolve();
    },
  };
}
