// Stand-in for the phase 4a game client (`apps/client/src/game/`), with the agreed signatures:
//   mountGame(el, conn, { onExit(results?) }) → { dispose() }
//   createSoloConnection({ loadout, owned, username, api }) → RoomConnection
// It acks loading, shows the run's phase and the results, and has a leave button. The solo
// connection calls `api.startRun()` before the run starts but runs no simulation, so it never
// ends on its own and never calls `api.reportRun`. Delete this file when 4a lands (see game.ts).
import { t } from '@pokesurvivor/data';
import {
  Emitter,
  SnapshotBuffer,
  type Results,
  type RoomConnection,
  type RoomConnectionEvents,
  type RoomConnectionPhase,
} from '@pokesurvivor/netclient';
import type { RunSummary } from '@pokesurvivor/protocol';
import type { PlayerConfig } from '@pokesurvivor/sim';
import type { RunReport } from './api.js';
import { h, replace } from './dom.js';

export interface MountGameOptions {
  /** The player left the run or closed the results; `results` if the run ended. */
  onExit(results?: Results): void;
}

export interface GameHandle {
  dispose(): void;
}

export interface SoloOptions {
  /** The player's partner and its upgrades, bindings and bans, from their save. */
  loadout: PlayerConfig;
  /** Pokémon the player owns (a rescued one they own pays coins instead). */
  owned: readonly number[];
  username: string;
  /** The server side of a solo run, bound to the player's session and partner by the shell. */
  api: SoloApi;
}

/**
 * Solo runs are simulated in the browser and credited by the server (`docs/api.md`, Runs). The
 * connection owns this: `startRun` before the run starts (the server caps the results by the
 * time since then), `reportRun` as soon as the sim ends, then it emits `results` with what was
 * credited. Reporting lives next to the sim so a closed tab on the results screen still counts,
 * and so checkpoints (phase 4c) can report from the same place.
 */
export interface SoloApi {
  startRun(): Promise<{ runId: string; startedAt: string }>;
  reportRun(runId: string, summary: RunSummary): Promise<RunReport>;
}

export function mountGame(
  el: HTMLElement,
  conn: RoomConnection,
  opts: MountGameOptions,
): GameHandle {
  let results: Results | undefined;
  const body = h('div', { class: 'box center game-stub', dataset: { testid: 'game-stub' } });
  el.append(body);
  const render = () => {
    const phase = conn.phase;
    replace(
      body,
      h('h2', null, t('app.gameStub')),
      h('p', { class: 'sub', dataset: { testid: 'game-phase' } }, phase),
      results
        ? h(
            'p',
            null,
            results.players.map((p) =>
              h('div', null, `${p.username}: ${p.summary.run.durationS} s, ${p.summary.run.coins}`),
            ),
          )
        : null,
      h(
        'button',
        {
          class: 'btn gold',
          dataset: { testid: 'game-exit' },
          on: { click: () => opts.onExit(results) },
        },
        phase === 'ended' ? t('pause.backToMenu') : t('pause.quitRun'),
      ),
    );
  };
  const offs = [
    conn.on('phase', render),
    conn.on('results', (r) => {
      results = r;
      render();
    }),
  ];
  render();
  // Nothing to load: ack straight away so the server can start the run.
  if (conn.phase === 'loading') conn.loaded();
  return {
    dispose() {
      for (const off of offs) off();
      body.remove();
    },
  };
}

/** A solo connection that only walks through the phases (no sim until 4a lands). */
export function createSoloConnection(opts: SoloOptions): RoomConnection {
  const emitter = new Emitter<RoomConnectionEvents>();
  let phase: RoomConnectionPhase = 'loading';
  let loadedOnce = false;
  const setPhase = (p: RoomConnectionPhase) => {
    phase = p;
    emitter.emit('phase', p);
  };
  return {
    selfId: opts.loadout.id,
    game: null,
    get phase() {
      return phase;
    },
    buffer: new SnapshotBuffer(),
    latest: null,
    ackedInputSeq: 0,
    serverSelf: null,
    unackedInputs: () => [],
    loaded() {
      if (phase !== 'loading' || loadedOnce) return;
      loadedOnce = true;
      // The run starts once the server has recorded its start.
      opts.api.startRun().then(
        () => setPhase('running'),
        (err: unknown) => {
          console.error('startRun failed', err);
          setPhase('ended');
        },
      );
    },
    sendInput: () => 0,
    startInputLoop: () => () => {},
    intent: () => Promise.resolve({ ok: false, error: 'stub' }),
    on: (event, handler) => emitter.on(event, handler),
  };
}
