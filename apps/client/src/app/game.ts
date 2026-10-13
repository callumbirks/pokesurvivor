// The in-game client (phase 4a) as the app shell sees it. Until 4a lands, the stub stands in with
// the same signatures; then point these exports at `../game/index.js` and delete the stub.
export { createSoloConnection, mountGame } from './game-stub.js';
export type { GameHandle, MountGameOptions, SoloOptions } from './game-stub.js';
