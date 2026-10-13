# PokéSurvivor

A Pokémon bullet-heaven (Survivor.io-style) with roguelike runs, a gacha collection and
co-op for up to 4 players. This repository is a fork of [pokesurvivor.com](https://pokesurvivor.com)
being rebuilt as a TypeScript monorepo with an authoritative game server.

> **Status:** rebuild in progress. The original game lives unchanged in [`legacy/`](legacy/)
> (and is served at `/legacy/`) until the new client reaches parity.

> **Crypto disclaimer:** PokéSurvivor has no official cryptocurrency, token or NFT. Any token
> using the game's name was created by third parties.

## Architecture

- **Server-authoritative.** One Node process runs the HTTP API, the WebSocket game server and
  the simulation for every multiplayer room. Clients send inputs; the server sends snapshots.
- **Postgres** (Drizzle ORM) for accounts, saves and the economy.
- **Hosting:** a single Docker image on Dokploy, behind Traefik. See [docs/deploy.md](docs/deploy.md).

```
packages/
  data/       game data (JSON) + zod schemas
  sim/        headless simulation, shared by server and client (no DOM)
  protocol/   client/server message types and encoding
apps/
  server/     Fastify HTTP API + WebSocket server + Postgres (Drizzle)
  client/     Vite + Canvas 2D client
legacy/       the original game, read-only reference
docs/         deployment and design notes
```

## Development

Requirements: Node 22, pnpm (`corepack enable` or `npm i -g pnpm`), Docker.

```sh
pnpm install
docker compose up -d   # Postgres on localhost:5432
pnpm dev               # server on :3000, client on http://localhost:5173
```

The dev client proxies `/ws`, `/api`, `/healthz` and `/legacy` to the server. Migrations run
when the server starts. Override settings in a root `.env` (see [.env.example](.env.example)).

| Command            | What it does                                           |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | server (tsx watch) + client (Vite)                     |
| `pnpm build`       | build the client and bundle the server                 |
| `pnpm start`       | run the built server (serves the built client too)     |
| `pnpm lint`        | ESLint + Prettier check (`pnpm format` to fix)         |
| `pnpm typecheck`   | `tsc` in every package                                 |
| `pnpm test`        | Vitest in every package                                |
| `pnpm db:generate` | create a migration from `apps/server/src/db/schema.ts` |
| `pnpm db:migrate`  | apply migrations to `DATABASE_URL`                     |
| `docker build .`   | the production image                                   |

## License and credits

Code is MIT; see [LICENSE](LICENSE). Third-party content is not MIT: the Pokémon sprites come
from [SpriteCollab](https://github.com/PMDCollab/SpriteCollab) under CC BY-NC 4.0 (authors in
[CREDITS.md](CREDITS.md)), the Pixelify Sans font is under the SIL OFL 1.1, and Pokédex data
comes from [PokeAPI](https://pokeapi.co/). (The paths in LICENSE predate the move to `legacy/`.)

Pokémon and all related names are trademarks of Nintendo, Creatures Inc., GAME FREAK and The
Pokémon Company. This is a non-commercial fan project, not affiliated with or endorsed by them.
