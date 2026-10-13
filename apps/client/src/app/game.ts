// The in-game client (phase 4a, `src/game/`) as the app shell sees it.
export { GAME_NOTICES, createSoloConnection, isRunClosed, mountGame } from '../game/index.js';
export { indexedDbRunStore, memoryRunStore } from '../game/index.js';
export type {
  GameHandle,
  MountGameOptions,
  SavedSoloRun,
  SoloApi,
  SoloOptions,
  SoloRunStore,
} from '../game/index.js';
