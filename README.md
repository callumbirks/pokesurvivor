# PokéSurvivor

A Pokémon bullet-heaven (Survivor.io-style) with roguelike runs, a gacha collection and
co-op for up to 4 players. This repository is a fork of [pokesurvivor.com](https://pokesurvivor.com)
running as a TypeScript monorepo with an authoritative game server.

> **Status:** the TypeScript rebuild is complete and live on Dokploy.

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
tools/        sprite manifest and collision-body generation
assets/       sprites (served at /sprites/) and animation metadata
docs/         deployment and design notes
```

## Development

Requirements: Node 22, pnpm (`corepack enable` or `npm i -g pnpm`), Docker.

```sh
pnpm install
docker compose up -d   # Postgres on localhost:5432
pnpm dev               # server on :3000, client on http://localhost:5173
```

The dev client proxies `/ws`, `/api`, `/healthz`, `/sprites` to the server. Migrations run
when the server starts. Override settings in a root `.env` (see [.env.example](.env.example)).

| Command            | What it does                                           |
| ------------------ | ------------------------------------------------------ |
| `pnpm dev`         | server (tsx watch) + client (Vite)                     |
| `pnpm build`       | build the client and bundle the server                 |
| `pnpm start`       | run the built server (serves the built client too)     |
| `pnpm lint`        | ESLint + Prettier check (`pnpm format` to fix)         |
| `pnpm changelog`   | regenerate `CHANGELOG.md` from the changelog JSON      |
| `pnpm release`     | number a release and tag it (see docs/deploy.md)       |
| `pnpm typecheck`   | `tsc` in every package                                 |
| `pnpm test:slow`   | opt-in 20-minute progression/endurance run             |
| `pnpm test`        | Vitest in every package                                |
| `pnpm db:generate` | create a migration from `apps/server/src/db/schema.ts` |
| `pnpm db:migrate`  | apply migrations to `DATABASE_URL`                     |
| `docker build .`   | the production image                                   |

Every pull request that changes something players notice adds a line to the changelog: see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Manual collection/economy projections are available in [tools/gacha](tools/gacha/README.md).
They compare hypothetical rates without changing the game or running in CI.

## License and credits

Code is MIT; see [LICENSE](LICENSE). Third-party content is not MIT: the Pokémon sprites come
from [SpriteCollab](https://github.com/PMDCollab/SpriteCollab) under CC BY-NC 4.0 (authors in
[CREDITS.md](CREDITS.md)), the Pixelify Sans font is under the SIL OFL 1.1, and Pokédex data
comes from [PokeAPI](https://pokeapi.co/).

Pokémon and all related names are trademarks of Nintendo, Creatures Inc., GAME FREAK and The
Pokémon Company. This is a non-commercial fan project, not affiliated with or endorsed by them.
