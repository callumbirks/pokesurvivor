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
| `src/app/dom.ts`                                 | `h()`, pixel icons (`icon()`, rarity Poké Balls, `tNodes()`), sprites with `fit`/`feet`        |
| `src/app/slots.ts`                               | The gacha's pixel-art slot machine (port of original `slots.js`)                               |
| `src/app/backdrop.ts`                            | The living world behind the menus (port of legacy's `Backdrop`)                                |
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

## The legacy look

- **Icons** are the pixel-art set in `src/icons.ts` (port of original `icons.js`), as `<img>` via
  `icon(name, size)` or inside UI strings with `tNodes()` (`{ticket}` placeholders). Rarity is a
  Poké Ball (`rarityBall`: Poké, Great, Ultra, Luxury, Master), as in legacy. `--ico-cursor`
  and friends are CSS variables for the stylesheet (the menu's pixel cursor).
- **Sprites in fixed boxes** take `fit` (the box) and `feet`: `fitScale()` keeps the view's
  pixel scale when the frame fits and otherwise the largest whole scale that does, measured from
  the real frame (width, and the body above the feet: `anchorY`), so giants like Eternatus
  never overflow a banner, card or stage. With `feet`, the frame's space below the feet hangs
  under the container's edge, so a row of Pokémon shares one baseline. `sprite-fit.test.ts`
  checks every Pokémon against each box.
- **Gacha reveal**: the slot machine (lever, reels, suspense on epic/legendary/shiny, the tray),
  click to speed up; it plays the `ball`, `shake`, `reveal`, `legend` and `shiny` sounds on its
  beats, then the burst and a card per pull.
- **Backdrop**: the run map with 20 wandering Pokémon and a drifting camera, a biome change
  every 30 s, drawn with `src/game/scene/` and moved with the sim's `WorldView.move`. Shown on
  every screen but `#play`. Calm mode and `prefers-reduced-motion` keep it still.

## Rooms and games

- The lobby (`#lobby`) shows the `RoomView`; the start button is the owner's, disabled while
  `blockers` isn't empty (the server checks again).
- **Busy.** Routes with `busy: true` (gacha, shop, collection, settings) make `BusyStatus` send
  `room.status busy`, and restore ready / not-ready on leaving them. It re-asserts busy after
  reconnects and joins, and handles a quick return before the server confirmed.
- When a game loads (`game.loading`, or `game.start` after a reload) the app opens `#play`,
  which calls `mountGame(el, conn, { onExit })` and shows who has loaded until the deadline.
  Quitting mid-run leaves the room (the server credits what was earned).
- **Solo** (`#solo`) is off while in a room: the menu entry and Play are disabled with the
  reason, and the server refuses `POST /api/runs/start` with `409 in_room`. The shell builds the loadout from the save (as the server builds coop
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
- **Rendering** (`scene/`): ports of original `tiles.js` (ground chunks baked at art resolution
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
- **HUD size** (`hudscale.ts`): the HUD is laid out in CSS px at the original sizes (made for
  windows up to ~1280 × 720) and drawn under one scale. The "HUD size" setting (Settings →
  Graphics, per device) is Auto by default: `min(w / 1280, h / 720)`, never below 1 (phones look
  as before) and at most 2 (1.5 at 1920 × 1080); or a fixed scale, 75–200% (moving the slider
  turns Auto off). Touch and click hit-testing use the same scale; HUD icons snap to whole device
  pixels. The manual-aim crosshair isn't scaled. Settings sliders are in `SLIDER_KEYS`
  (`screens/settings.ts`) so the screen doesn't redraw under a drag.
- **Choices** (`choices.ts` state, `choice-ui.ts` DOM): level-up cards with reroll, item swaps,
  two-step bonds; the deadline countdown and who's still choosing. Derived from every snapshot,
  so it closes when the choice leaves it; a pick with no answer is offered again.
- **Achievement notices** (`achievements.ts`): the save plus this run's totals and `progress`
  events, projected onto `achievements.json` as the server reads the save. Nothing is credited.
- **Input**: keyboard, gamepad (`input.ts`) and the touch joystick and buttons (`touch.ts`).
  Esc / P pauses: solo stops the worker; in a group the overlay is shown and the run goes on.
  In a choice the gamepad's d-pad or left stick moves a highlight and A picks it (after the
  same grace window as keys); B/X/Y pick options 2–4, Back rerolls, Start goes back in a bond.
  A direction held when a choice opens waits for release.
- **Prompts and menus with a gamepad** (shared with the shell, `src/`): `input-device.ts`
  tracks the device in use (keyboard and mouse, gamepad, touch; a button or a stick past half
  way switches to the pad, drift doesn't; a key, a click or 24 px of mouse travel switch back)
  and the pad's layout (PlayStation from `Gamepad.id`, else Xbox), mirrored as
  `<html data-input data-pad>`. `glyphs.ts` draws the glyphs (Kenney's CC0 pixel prompts,
  `public/glyphs/`) in the DOM (`inputHint`: keys or glyphs, chosen by CSS) and on the HUD
  (slots, the aim switch, the controls hint). The cursor hides while the pad is in use.
  `menu-nav.ts` moves a focus ring through the screen on top with the d-pad or left stick
  (repeating), A presses, B goes back, left / right move sliders and switches; the game pushes a
  blocking scope while playing, and the pause menu, settings and results push their own.
- **Aiming** (`aim.ts`): auto (the default) or manual, `settings.aimMode` (local to the device),
  switched with T, a gamepad's R3, the HUD's AIM button or the settings. Manual: the mouse aims
  from our Pokémon; on touch the left half of the screen moves and the right half is an aim
  stick that keeps its direction when let go; a gamepad's right stick aims. The aim goes out
  with every input, snapped to the wire's byte (`quantizeAim`); our Pokémon's facing and the
  arrow-and-arc indicator around it use it at once. With a mouse, a pixel-art crosshair (in `settings.crosshairColor`, magenta by default,
  local to the device; firing doesn't change it) replaces the system cursor over the game (not on HUD buttons, in menus, choices or pause, or on touch).
  Holding the left button over the game (not on a HUD button), or a gamepad's right trigger, is
  fire held (`fire` in the input): aimed moves fire on cooldown even with nothing in reach. The sim decides what it does (see "Aiming"
  in the sim README).
- **Results** (`results.ts`): what was credited (solo: the `RunReport`; co-op: `game.results`),
  the reward breakdown, moves, tickets, shinies, and who left early.
- **Solo** (`solo/`): the sim runs in a Web Worker and sends the same binary snapshots as the
  server, decoded by `NetRoomConnection`; `SoloApi` starts and reports the run.

Dev pages (`play.html`, dev server only): `/?play-solo` plays a solo run from your save
(`&t=<minutes>` starts late, `&god` is invulnerable, F/V/H/J/K/G/B then trigger a rift, the
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
  `screens.e2e.ts` covers the single-player screens. `aim.e2e.ts` switches to manual aim (T,
  the HUD button, the settings) and aims with the mouse, with twin sticks on a phone viewport,
  and in co-op, checking that the sim's aim follows. `solo-resume.e2e.ts` plays a solo run past
  a checkpoint, reloads, and resumes and finishes it (or ends it from the menu), checking it was
  credited once; and that hiding the page pauses the run and checkpoints it. Install the browser once with
  `pnpm --filter @pokesurvivor/client exec playwright install chromium`.
