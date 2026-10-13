# PokéSurvivor — working notes

A fork of pokesurvivor.com being rebuilt as a TypeScript monorepo with an authoritative game
server. The agreed plan (architecture, phases, decisions) is in the project file
`plans/rebuild-architecture.md` (in the borkcode project files, not in this repo); read it
before larger changes.

## Layout

- `packages/data` — game data (`json/`), zod schemas, and UI strings (`i18n/en.json`); see its
  README. The JSON is the source of truth (generated once from legacy by `tools/legacy-data`).
- `packages/sim` — headless simulation (world, entities, combat, …). Runs in Node and in a Web
  Worker. **No DOM, Canvas, Audio or browser globals** (ESLint enforces the globals).
- `packages/protocol` — client/server message types, encoding, `PROTOCOL_VERSION`.
- `apps/server` — Fastify HTTP API, WebSocket game server (`/ws`), Postgres via Drizzle.
  Also serves the built client at `/` and `legacy/` at `/legacy/`.
- `apps/client` — Vite + Canvas 2D client.
- `assets/` — sprites (`assets/pokemon/{dex}/`), served at `/sprites/` and, for legacy,
  `/legacy/assets/pokemon/`. The manifest is `packages/data/json/sprites.json`; regenerate it
  (`pnpm --filter @pokesurvivor/tools convert-legacy-data --only sprites.json`) if sprites change.
- `tools/` — one-off scripts (legacy data conversion, UI string seeding).
- `legacy/` — the original vanilla-JS game. **Read-only reference**: don't edit it (except to
  keep it servable) and don't import from it. Its own `CLAUDE.md`/README describe the old
  Firebase/GitHub Pages workflow, which no longer applies.

Workspace packages export TypeScript source (`"exports": "./src/index.ts"`); there is no
per-package build. Vite, Vitest and tsx compile them, and the server build bundles them with
esbuild (`apps/server/scripts/build.js`). Runtime npm dependencies of the server must be in its
`dependencies` (they stay external); workspace packages go in `devDependencies`.

## Commands

```sh
pnpm install
docker compose up -d     # local Postgres
pnpm dev                 # server :3000 + client :5173 (proxies /ws, /api, /healthz, /legacy)
pnpm lint                # ESLint + Prettier check; `pnpm format` fixes formatting
pnpm typecheck
pnpm test
pnpm build
pnpm db:generate --name <change>   # after editing apps/server/src/db/schema.ts
pnpm db:migrate                    # also runs automatically on server start
docker build .
```

Run `pnpm lint && pnpm typecheck && pnpm test` before committing. The server tests need Postgres
(`docker compose up -d`, or `DATABASE_URL`); each test file creates and drops its own database.
The HTTP API is documented in `docs/api.md`; keep it in sync.

## Conventions

- **English only**: identifiers, comments, docs, commit messages and UI text. UI strings live in
  `packages/data/i18n/en.json` (use `t()`); don't hard-code user-facing text in logic.
- **TypeScript strict** everywhere (`tsconfig.base.json`, incl. `noUncheckedIndexedAccess`). No
  `any` escape hatches without a comment saying why.
- **Game logic lives only in `packages/sim`.** The client renders, plays audio and collects
  input; it never decides outcomes.
- **The server is authoritative.** Clients send inputs and intents; the server owns game state,
  room state, saves, gacha rolls and the economy. Never trust values computed on the client.
- Wire-format changes go through `packages/protocol` and bump `PROTOCOL_VERSION` when breaking.
- Schema changes go through Drizzle migrations; never edit a migration that has been merged.
- Config comes from environment variables (`apps/server/src/config.ts`, `.env.example`).
- Deployment: see `docs/deploy.md` (Dokploy, one Docker image, Postgres service).
