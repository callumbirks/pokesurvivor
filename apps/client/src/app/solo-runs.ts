// Solo runs as the shell drives them: `SoloApi` bound to the session (keeping the save and the
// toasts up to date), starting a run, and the locally saved unfinished run (`SoloRunStore`) that
// the menu offers to resume or end after a reload, a crash or a closed tab.
import { t } from '@pokesurvivor/data';
import type { RunSummary } from '@pokesurvivor/protocol';
import type { PlayerConfig } from '@pokesurvivor/sim';
import type { App } from './app.js';
import type { PokemonRef } from './api.js';
import {
  createSoloConnection,
  indexedDbRunStore,
  isRunClosed,
  memoryRunStore,
  type SavedSoloRun,
  type SoloApi,
  type SoloRunStore,
} from './game.js';
import { errorText, toast, toastError } from './toast.js';

/** This browser's saved solo runs (in memory where IndexedDB is unavailable). */
export const soloRunStore: SoloRunStore =
  typeof indexedDB === 'undefined' ? memoryRunStore() : indexedDbRunStore();

/**
 * Run time between checkpoints. Dev builds only: `localStorage['ps.dev.checkpointS']` shortens
 * it (the e2e tests checkpoint every few seconds instead of every minute).
 */
function checkpointEveryS(): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  const s = Number(localStorage.getItem('ps.dev.checkpointS'));
  return s > 0 ? s : undefined;
}

const codeOf = (err: unknown) => (err as { code?: unknown } | null)?.code;
const closed = (err: unknown) => {
  const code = codeOf(err);
  return typeof code === 'string' && isRunClosed(code);
};

/** The calls a solo run makes, bound to this player's session and the partner it starts with. */
function soloApi(app: App, pokemon: PokemonRef): SoloApi {
  return {
    startRun: () =>
      app.api.startRun(pokemon).catch((err: unknown) => {
        toastError(err);
        throw err;
      }),
    // Silent: a missed checkpoint is covered by the next one and the local save.
    checkpointRun: (runId, summary) => app.api.checkpointRun(runId, summary),
    reportRun: async (runId, summary) => {
      try {
        return await report(app, runId, summary);
      } catch (err) {
        // A closed run's results screen says why; other failures get a toast.
        if (!closed(err)) toastError(err);
        throw err;
      }
    },
  };
}

async function report(app: App, runId: string, summary: RunSummary) {
  const res = await app.api.reportRun(runId, summary);
  app.setSave(res.save);
  app.achievements(res.achievements);
  return res;
}

/** Starts a solo run with this loadout and opens the play screen. */
export function playSolo(app: App, loadout: PlayerConfig, owned: number[]): void {
  const conn = createSoloConnection({
    loadout,
    owned,
    username: app.user?.username ?? '',
    api: soloApi(app, { dex: loadout.dex, shiny: !!loadout.shiny }),
    store: soloRunStore,
    checkpointEveryS: checkpointEveryS(),
    onClock: (clock) => app.net?.setSoloClock(clock),
  });
  app.startGame({ conn, kind: 'solo' });
}

/** The player's unfinished solo run saved in this browser, if any. */
export async function savedSoloRun(app: App): Promise<SavedSoloRun | null> {
  if (!app.user) return null;
  try {
    return await soloRunStore.get(app.user.id);
  } catch (err) {
    console.warn('[solo] reading the local save failed:', err);
    return null;
  }
}

/**
 * Resumes a saved run on its `runId`. A checkpoint of the saved summary first checks the run is
 * still open on the server (and restarts its timeout); if the server credited it meanwhile, the
 * save is dropped and false returned. Offline, the run is resumed anyway.
 */
export async function resumeSolo(app: App, saved: SavedSoloRun): Promise<boolean> {
  if (!saved.state) return false;
  try {
    await app.api.checkpointRun(saved.runId, saved.summary);
  } catch (err) {
    if (closed(err)) {
      await soloRunStore.delete(saved.userId, saved.runId);
      toast(errorText(err), 'info', 4500);
      return false;
    }
  }
  const pokemon = { dex: saved.loadout.dex, shiny: !!saved.loadout.shiny };
  const conn = createSoloConnection({
    loadout: saved.loadout,
    owned: saved.owned,
    username: saved.username,
    api: soloApi(app, pokemon),
    store: soloRunStore,
    resume: saved,
    checkpointEveryS: checkpointEveryS(),
    onClock: (clock) => app.net?.setSoloClock(clock),
  });
  app.startGame({ conn, kind: 'solo' });
  return true;
}

/**
 * Ends a saved run without playing on: reports its saved summary as the final report, so the
 * player is credited for what they had. The save is dropped once the run is credited or closed
 * on the server; offline it is kept (throws, for `app.act` to toast).
 */
export async function endSavedRun(app: App, saved: SavedSoloRun): Promise<void> {
  try {
    const res = await report(app, saved.runId, saved.summary);
    const coins = (res.stats as { coins?: number } | null)?.coins ?? 0;
    toast(t('app.savedRunCredited', { 0: coins }), 'good', 4500);
  } catch (err) {
    if (!closed(err)) throw err;
    toast(errorText(err), 'info', 4500);
  }
  await soloRunStore.delete(saved.userId, saved.runId);
}
