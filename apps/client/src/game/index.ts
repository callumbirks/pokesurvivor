// The in-game client: everything from loading a run to its results (phase 4a). The app shell
// mounts it with a RoomConnection: the game server's (`NetClient.room`) or a solo one.
//   mountGame(el, conn, { onExit(results?), onLeave?, client?, save? }) → { dispose() }
//   createSoloConnection({ loadout, owned, username, api, store?, resume? }) → RoomConnection (the
//     sim in a Web Worker; `api.startRun` before the run, `api.checkpointRun` about once a minute
//     (saved to `store` too), `api.reportRun` when it ends; `resume` continues a saved run)
export { mountGame } from './mount.js';
export type { GameClient, GameHandle, MountGameOptions } from './mount.js';
export { GAME_NOTICES } from './notices.js';
export { createSoloConnection, isRunClosed, isSoloResults } from './solo/connection.js';
export { indexedDbRunStore, memoryRunStore } from './solo/store.js';
export type { SavedSoloRun, SoloRunStore } from './solo/store.js';
export type {
  SoloApi,
  SoloConnection,
  SoloOptions,
  SoloReport,
  SoloResults,
} from './solo/connection.js';
export type { AchievementSave } from './achievements.js';
