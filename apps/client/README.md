# @pokesurvivor/client

The browser client: Vite, no UI framework. The menus are DOM (`h()` in `src/app/dom.ts`), the
run is Canvas 2D (`src/game/`, phase 4a). Styles are `src/styles.css`, ported from the legacy
look (blue Mystery Dungeon boxes, the Pixelify Sans font in `public/fonts/`, OFL).

## Layout

| Path                   | What                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `src/main.ts`          | Starts the app, or a dev-only view (`/?debug-sim`, `/?debug-net`)                      |
| `src/app/app.ts`       | The shell: routes, session, save cache, WebSocket lifecycle, top bar, invites, games   |
| `src/app/api.ts`       | The HTTP API (`docs/api.md`), typed; errors are `ApiError` with the server's `code`    |
| `src/app/busy.ts`      | `BusyStatus`: `busy` in the room while on a busy screen, then the previous status back |
| `src/app/toast.ts`     | Toasts, sticky notices, and `errorText()` (error code → `errors.<code>` in `en.json`)  |
| `src/app/dom.ts`       | `h()`, sprites (CSS background from the sprite sheet), stars, type chips               |
| `src/app/game.ts`      | `mountGame` / `createSoloConnection` (the 4a contract; a stub until 4a lands)          |
| `src/screens/index.ts` | The routes: `#menu`, `#gacha`, … and which are public / busy / show the top bar        |
| `src/settings.ts`      | The settings store (local, synced to the save's `settings`), read by the game          |
| `e2e/`                 | Playwright tests against a real server                                                 |

## The app shell

- **Routes** are hash routes (`#collection?dex=25`), so back and forward work and the server
  needs no SPA fallback. `App.render()` gates them: logged out → `#login`; no Pokémon yet →
  `#starter`; `#play` only with a game.
- **Session.** On load `GET /api/auth/me`, then the save, then the WebSocket. A 401 from any
  call logs out with a notice; an unreachable server shows a retry.
- **WebSocket.** One `NetClient` while logged in. `reconnecting` shows a sticky notice; a
  final close (superseded by another tab, version mismatch) shows one with a reload button;
  `server-draining` shows "server updating" until a reconnect reaches a new instance.
- **Every API call** has a loading and an error state: actions go through `app.act(button,
fn)` (spinner on the button, toast on error), loads through `loadInto(el, load, show)`
  (spinner, then an error with a retry button).
- **The server decides.** Pulls, purchases, claims and starter grants send intents and show the
  save the server returns. Gacha rates, pity, costs and upgrade prices come from the server.

## Rooms and games

- The lobby (`#lobby`) shows the `RoomView`; the start button is the owner's, disabled while
  `blockers` isn't empty (the server checks again).
- **Busy.** Routes with `busy: true` (gacha, shop, collection, settings) make `BusyStatus` send
  `room.status busy`, and restore ready / not-ready on leaving them. It re-asserts busy after
  reconnects and joins, and handles a quick return before the server confirmed.
- When a game loads (`game.loading`, or `game.start` after a reload) the app opens `#play`,
  which calls `mountGame(el, conn, { onExit })` and shows who has loaded until the deadline.
  Quitting mid-run leaves the room (the server credits what was earned).
- **Solo** (`#solo`): `POST /api/runs/start`, then `createSoloConnection({ loadout, owned,
username })` with the loadout built from the save as the server builds coop ones, then
  `mountGame`. On exit with results, the run's `RunSummary` is reported to `POST /api/runs`.

## Tests

- `pnpm --filter @pokesurvivor/client test`: Vitest (`BusyStatus`, the routes).
- `pnpm --filter @pokesurvivor/client e2e`: Playwright. Starts the game server (on
  `DATABASE_URL`, default the docker compose Postgres) on port 3101 and Vite on 5181, or tests a
  running client with `E2E_BASE_URL`. `coop.e2e.ts` is the phase 4 exit test: two browsers,
  friends, invite, both ready, one opens the gacha and the start is blocked, both play.
  `screens.e2e.ts` covers the single-player screens. Install the browser once with
  `pnpm --filter @pokesurvivor/client exec playwright install chromium`.
