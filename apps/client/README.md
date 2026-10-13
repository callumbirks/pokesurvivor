# @pokesurvivor/client

The browser client: Vite, no UI framework. The menus are DOM (`h()` in `src/app/dom.ts`), the
run is Canvas 2D (`src/game/`, phase 4a). Styles are `src/styles.css`, ported from the legacy
look (blue Mystery Dungeon boxes, the Pixelify Sans font in `public/fonts/`, OFL).

## Layout

| Path                                             | What                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/main.ts`                                    | Starts the app, or a dev-only view (`/?debug-sim`, `/?debug-net`, `/?play-solo`, `/?play-net`) |
| `src/app/app.ts`                                 | The shell: routes, session, save cache, WebSocket lifecycle, top bar, invites, games           |
| `src/app/api.ts`                                 | The HTTP API (`docs/api.md`), typed; errors are `ApiError` with the server's `code`            |
| `src/app/busy.ts`                                | `BusyStatus`: `busy` in the room while on a busy screen, then the previous status back         |
| `src/app/toast.ts`                               | Toasts, sticky notices, and `errorText()` (error code → `errors.<code>` in `en.json`)          |
| `src/app/dom.ts`                                 | `h()`, sprites (CSS background from the sprite sheet), stars, type chips                       |
| `src/app/game.ts`                                | `mountGame` / `createSoloConnection`: the shell's view of `src/game/`                          |
| `src/game/`                                      | The in-game client: renderer, prediction, HUD, choices, results, solo worker (below)           |
| `src/icons.ts`, `src/sprites.ts`, `src/audio.ts` | Pixel icons, Pokémon sprite sheets and animator, the Web Audio synth (shared)                  |
| `src/screens/index.ts`                           | The routes: `#menu`, `#gacha`, … and which are public / busy / show the top bar                |
| `src/settings.ts`                                | The settings store (local, synced to the save's `settings`), read by the game                  |
| `e2e/`                                           | Playwright tests against a real server                                                         |

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
- **Solo** (`#solo`): the shell builds the loadout from the save (as the server builds coop
  ones) and calls `createSoloConnection({ loadout, owned, username, api })`, then `mountGame`.
  `api` (`SoloApi`) is `startRun()` and `reportRun(runId, summary)`, bound to the player's
  session and partner (they also update the save, toast unlocked achievements and errors). The
  **connection** owns the run on the server: it calls `startRun` before the run starts and
  `reportRun` as soon as the sim ends, then emits `results` with what was credited, so the
  results screen shows it and a tab closed on that screen still counts. `onExit(results?)` only
  goes back to the menu and refreshes the save. `src/app/solo-runs.ts` builds the `SoloApi` and
  starts, resumes and ends runs.
- **Solo crash-safety.** About every minute of run time (`CHECKPOINT_EVERY_S`; and every 3
  minutes of wall-clock time while paused or choosing, and when the page is hidden or closed:
  the game screen also pauses a hidden solo run until the player continues) the worker sends a
  checkpoint: the run so far and a copy of the sim state. The connection reports it
  (`checkpointRun`, `POST /api/runs/checkpoint`: stored, not credited; the server credits it
  after an hour without news) and saves it in IndexedDB (`solo/store.ts`, one save per user).
  Between those, the worker sends a checkpoint to save locally only as the run starts and every
  5 s of run time (`SAVE_EVERY_S`): a reload or closed tab can't wait for the worker, so it
  resumes from the latest of these, and `pagehide` reports that latest summary at once.
  Checkpoints use `fetch` `keepalive`, so they survive the tab closing. The save is dropped once the run is credited or the server says it's closed; if the
  final report can't reach the server it keeps the final summary instead. The menu shows a saved
  run with **Resume** (a checkpoint first checks the run is still open; then `restoreSim` in the
  worker on the same `runId`) or **End run** (reports the saved summary as the final report). A
  run the server already credited by timeout can't be resumed (`docs/api.md`). If an open tab
  comes back to such a run (a phone away longer than the timeout), its next checkpoint is
  refused: the connection ends the run there, and the results show what the server credited
  ("away too long", from the 409's `credited`).

## The in-game client (`src/game/`)

`mountGame(el, conn, { onExit, onLeave?, client?, save? })` plays a run over any `RoomConnection`
(the server's `NetClient.room`, or `createSoloConnection`'s), from loading to results:

- **Loading**: preloads the players', bosses' and first tiers' sprites (`GameStatic.roster`),
  then `conn.loaded()`. Later tiers load during the run.
- **Rendering** (`scene/`): ports of legacy `tiles.js` (ground chunks baked at art resolution
  from the sim's `WorldView`, biome crossfade, palettes from `biomes.json`), `vfx.js`, `fx.js`,
  the entities' drawing (client animators driven by snapshot state and events, corpses fading
  out), weather and the camera. `events.ts` turns sim events into effects, numbers, sounds and
  shakes; they play when the interpolated view reaches their snapshot.
- **Netcode**: everything is drawn ~100 ms in the past from `SnapshotBuffer` (50 ms solo),
  except our Pokémon: `net/predict.ts` replays the unacked inputs from the server's position with
  the sim's own movement step (`WorldView.move`, speed from the snapshot's `self`), blends across
  the current tick and eases corrections out (teleports snap). Gaps resync in `NetRoomConnection`.
- **HUD** (`hud.ts`, canvas): XP, HP and level, clock, weather, boss bar, move slots with
  cooldowns, held item, bonds, teammates (HP, down, choosing, offline), edge arrows (rift,
  teammates, shinies, the lost Pokémon, thieves), event timers, banners. Toasts (DOM) for
  teammates leaving and coming back, server notices (with `client`) and achievements.
- **Choices** (`choices.ts` state, `choice-ui.ts` DOM): level-up cards with reroll, item swaps,
  two-step bonds; the deadline countdown and who's still choosing. Derived from every snapshot,
  so it closes when the choice leaves it; a pick with no answer is offered again.
- **Achievement notices** (`achievements.ts`): the save plus this run's totals and `progress`
  events, projected onto `achievements.json` as the server reads the save. Nothing is credited.
- **Input**: keyboard, gamepad (`input.ts`) and the touch joystick and buttons (`touch.ts`).
  Esc / P pauses: solo stops the worker; in a group the overlay is shown and the run goes on.
- **Results** (`results.ts`): what was credited (solo: the `RunReport`; co-op: `game.results`),
  the reward breakdown, moves, tickets, shinies, and who left early.
- **Solo** (`solo/`): the sim runs in a Web Worker and sends the same binary snapshots as the
  server, decoded by `NetRoomConnection`; `SoloApi` starts and reports the run.

Dev pages (`play.html`, dev server only): `/?play-solo` plays a solo run from your save
(`&t=<minutes>` starts late, `&god` is invulnerable, F/V/H/J/K/T/B then trigger a rift, the
arena, events and weather; such runs aren't reported), `/?play-net` a co-op run with a minimal
lobby. Dev builds expose `window.__psFrames` (per-frame cost) and `window.__psCounts`, and
read `localStorage['ps.dev.checkpointS']`: solo checkpoints every that many seconds of run time
instead of 60 (the e2e tests use 2).

## Tests

- `pnpm --filter @pokesurvivor/client test`: Vitest (`BusyStatus`, the routes, prediction and
  reconciliation against a real sim behind latency, the choice state, achievement notices, the
  solo connection with its real worker run inline on fake timers: checkpoint cadence, keep-alive,
  the local save through reports, refusals and offline, resume; and the run store's save and
  restore round trip, in IndexedDB through `fake-indexeddb`).
- `pnpm --filter @pokesurvivor/client e2e`: Playwright. Starts the game server (on
  `DATABASE_URL`, default the docker compose Postgres) on port 3101 and Vite on 5181, or tests a
  running client with `E2E_BASE_URL`. `coop.e2e.ts` is the phase 4 exit test: two browsers,
  friends, invite, both ready, one opens the gacha and the start is blocked, both play.
  `screens.e2e.ts` covers the single-player screens. `solo-resume.e2e.ts` plays a solo run past
  a checkpoint, reloads, and resumes and finishes it (or ends it from the menu), checking it was
  credited once; and that hiding the page pauses the run and checkpoints it. Install the browser once with
  `pnpm --filter @pokesurvivor/client exec playwright install chromium`.
