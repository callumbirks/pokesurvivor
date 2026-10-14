// Every screen outside a run, by route (`#name`). `busy` screens set the room status to busy.
import type { Route } from '../app/app.js';
import { changelogScreen } from './changelog.js';
import { collectionScreen } from './collection.js';
import { friendsScreen } from './friends.js';
import { gachaScreen } from './gacha.js';
import { goalsScreen } from './goals.js';
import { lobbyScreen } from './lobby.js';
import { loginScreen } from './login.js';
import { menuScreen } from './menu.js';
import { playScreen } from './play.js';
import { rankingScreen } from './ranking.js';
import { settingsScreen } from './settings.js';
import { shopScreen } from './shop.js';
import { soloScreen } from './solo.js';
import { starterScreen } from './starter.js';

export const routes: Record<string, Route> = {
  login: { create: loginScreen, public: true },
  starter: { create: starterScreen, noPartner: true },
  menu: { create: menuScreen, topbar: true },
  solo: { create: soloScreen, topbar: true },
  lobby: { create: lobbyScreen, topbar: true },
  friends: { create: friendsScreen, topbar: true },
  collection: { create: collectionScreen, topbar: true, busy: true },
  gacha: { create: gachaScreen, topbar: true, busy: true },
  shop: { create: shopScreen, topbar: true, busy: true },
  settings: { create: settingsScreen, busy: true },
  goals: { create: goalsScreen, topbar: true },
  ranking: { create: rankingScreen, topbar: true },
  changelog: { create: changelogScreen, topbar: true },
  play: { create: playScreen },
};

/** The routes that mark a room member busy (gacha, shop, collection, settings). */
export const BUSY_ROUTES = Object.entries(routes)
  .filter(([, r]) => r.busy)
  .map(([name]) => name);
