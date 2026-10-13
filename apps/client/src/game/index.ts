// The in-game client: everything from loading a run to its results (phase 4a). The app shell
// mounts it with a RoomConnection: the game server's (`NetClient.room`) or a solo one.
//   mountGame(el, conn, { onExit(results?), onLeave?, client?, save? }) → { dispose() }
//   createSoloConnection({ loadout, owned, username }) → RoomConnection (the sim in a Web Worker)
//   loadSoloLoadout() → { loadout, owned, username } from the player's save
export { mountGame } from './mount.js';
export type { GameHandle, MountGameOptions } from './mount.js';
export { createSoloConnection, isSoloResults, loadSoloLoadout } from './solo/connection.js';
export type { SoloConnection, SoloOptions, SoloReport, SoloResults } from './solo/connection.js';
export type { AchievementSave } from './achievements.js';
