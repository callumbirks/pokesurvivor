// Stand-in for the phase 4a game client (`apps/client/src/game/`), with the agreed signatures:
//   mountGame(el, conn, { onExit(results?) }) → { dispose() }
//   createSoloConnection({ loadout, ... }) → RoomConnection
// It acks loading, shows the run's phase and the results, and has a leave button. The solo
// connection runs no simulation: it starts and ends without results. Delete this file when 4a
// lands (see game.ts).
import { t } from '@pokesurvivor/data';
import {
  Emitter,
  SnapshotBuffer,
  type Results,
  type RoomConnection,
  type RoomConnectionEvents,
  type RoomConnectionPhase,
} from '@pokesurvivor/netclient';
import type { PlayerConfig } from '@pokesurvivor/sim';
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
      if (phase === 'loading') setTimeout(() => setPhase('running'), 0);
    },
    sendInput: () => 0,
    startInputLoop: () => () => {},
    intent: () => Promise.resolve({ ok: false, error: 'stub' }),
    on: (event, handler) => emitter.on(event, handler),
  };
}
