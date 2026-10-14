# PokéSurvivor — working notes

A fork of pokesurvivor.com running as a TypeScript monorepo with an authoritative game
server. The agreed plan (architecture, phases, decisions) is in the project file
`plans/rebuild-architecture.md` (in the borkcode project files, not in this repo); read it
before larger changes.

## Layout

- `packages/data` — game data (`json/`), zod schemas, and UI strings (`i18n/en.json`); see its
  README. The JSON is the source of truth.
- `packages/sim` — headless simulation (world, entities, combat, …). Runs in Node and in a Web
  Worker. **No DOM, Canvas, Audio or browser globals, and deterministic**: randomness only from
  the seeded RNG in its state, time only from its fixed tick (ESLint enforces both). See its
  README for the API, state, events and netcode notes; `/?debug-sim` in `pnpm dev` draws it.
- `packages/protocol` — client/server message types and validation, the delta-table snapshot
  codec, `PROTOCOL_VERSION`. Sim-agnostic: game payloads are generic. See `docs/protocol.md`.
- `packages/netclient` — the client side of the protocol (DOM-free: browser and Node bots):
  `NetClient`, `RoomConnection`, the snapshot buffer, and the sim → snapshot projection that the
  server shares (`SnapshotEncoder`).
- `apps/server` — Fastify HTTP API, WebSocket game server (`/ws`, `src/game/`: sessions,
  presence, rooms, the authoritative loop), Postgres via Drizzle. `src/test/bots.ts` is the bot
  harness for game tests. Solo runs are client-simulated: the server caps their reports, stores
  checkpoints and credits the last one if the final report never comes (`src/runs/`; see
  `docs/api.md`, "Checkpoints and the timeout credit").
  Also serves the built client at `/`.
- `apps/client` — Vite + Canvas 2D client; see its README. `src/app/` is the app shell (hash
  routes, session, save cache, WebSocket lifecycle, toasts, the typed HTTP API, `BusyStatus`),
  `src/screens/` every screen outside a run (login, starter, menu, collection, gacha, shop, goals,
  leaderboard, friends, lobby, settings, solo, play), `src/settings.ts` the settings store the
  game reads, `src/game/` the in-game client (renderer, prediction, HUD, choices, results, the solo
  Web Worker; see the README). Dev-only views: `/?debug-sim` (sim locally), `/?debug-net` (log
  in, rooms, play over the network; use a private window or `127.0.0.1` for a second account),
  and `/?play-solo` / `/?play-net` (the real game client on a test page, `play.html`).
- `assets/` — sprite sheets (`pokemon/{dex}/`), served at `/sprites/`, and their animation
  metadata (`sprite-metadata.json`). Regenerate `packages/data/json/sprites.json` and
  `bodies.json` with `pnpm --filter @pokesurvivor/tools generate-sprites` after changing sprites.
  See the data README for geometry/timing edits.
- `tools/` — sprite manifest and collision-body generation from assets; the changelog CLI
  (`pnpm changelog`, `pnpm release`; source `packages/data/changelog.json`, see CONTRIBUTING.md).

Workspace packages export TypeScript source (`"exports": "./src/index.ts"`); there is no
per-package build. Vite, Vitest and tsx compile them, and the server build bundles them with
esbuild (`apps/server/scripts/build.js`). Runtime npm dependencies of the server must be in its
`dependencies` (they stay external); workspace packages go in `devDependencies`.

## Commands

```sh
pnpm install
docker compose up -d     # local Postgres
pnpm dev                 # server :3000 + client :5173 (proxies /ws, /api, /healthz, /sprites)
pnpm lint                # ESLint + Prettier check; `pnpm format` fixes formatting
pnpm typecheck
pnpm test                # fast regression suite
pnpm test:slow           # opt-in 20-minute progression/endurance run
pnpm build
pnpm --filter @pokesurvivor/sim bench   # sim tick times (4 players, late game, stress)
pnpm --filter @pokesurvivor/client e2e  # Playwright: starts a server (DATABASE_URL) + Vite on 3101/5181
pnpm db:generate --name <change>   # after editing apps/server/src/db/schema.ts
pnpm db:migrate                    # also runs automatically on server start
docker build .
```

Run `pnpm lint && pnpm typecheck && pnpm test` before committing. The server tests need Postgres
(`docker compose up -d`, or `DATABASE_URL`); each test file creates and drops its own database.
The HTTP API is documented in `docs/api.md` and the WebSocket protocol in `docs/protocol.md`;
keep them in sync. `pnpm --filter @pokesurvivor/netclient bandwidth` measures snapshot bandwidth (opt-in, not part of CI).

CI runs lint, typecheck, each test package, browser flows and Docker in parallel. Docker builds
both apps; CI does not repeat that build on another runner. Vitest uses two threads per package;
Playwright splits isolated tests across two CI shards, with two workers on each runner. pnpm and browser downloads are cached, and only
the server tests and e2e jobs start Postgres. Lint skips binary sprite directories.

## Conventions

- **English only**: identifiers, comments, docs, commit messages and UI text. UI strings live in
  `packages/data/i18n/en.json` (use `t()`); don't hard-code user-facing text in logic.
- **TypeScript strict** everywhere (`tsconfig.base.json`, incl. `noUncheckedIndexedAccess`). No
  `any` escape hatches without a comment saying why.
- **Game logic lives only in `packages/sim`.** The client renders, plays audio and collects
  input; it never decides outcomes.
- **The server is authoritative.** Clients send inputs and intents; the server owns game state,
  room state, saves, gacha rolls and the economy. Never trust values computed on the client.
- **Busy screens.** A screen that takes a room member away from the lobby (gacha, shop,
  collection, settings) sets `busy: true` on its route in `apps/client/src/screens/index.ts`, so
  the owner can't start without them; `BusyStatus` restores their status on return.
- Wire-format changes go through `packages/protocol` and bump `PROTOCOL_VERSION` when breaking.
- Schema changes go through Drizzle migrations; never edit a migration that has been merged.
- Config comes from environment variables (`apps/server/src/config.ts`, `.env.example`).
- Deployment: see `docs/deploy.md` (Dokploy, one Docker image, Postgres service).
