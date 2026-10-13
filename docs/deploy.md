# Deploying on Dokploy

The whole game is one Docker image: a Node 22 process that serves the client, the HTTP API, the
WebSocket game server (`/ws`) and the legacy game (`/legacy/`) on one port (`PORT`, default
`3000`). The only other service it needs is Postgres.

## 1. Create the database

In the Dokploy project: **Create Service → Database → PostgreSQL**.

- Pick a database name, user and a strong password (e.g. `pokesurvivor` / `pokesurvivor`).
- Use Postgres 17 (the version CI and `docker-compose.yml` use).
- Don't expose it publicly. Deploy it, then copy its **Internal Connection URL**, which looks like
  `postgresql://pokesurvivor:<password>@<service-app-name>:5432/pokesurvivor`. Apps in the same
  Dokploy instance reach it over Dokploy's internal network.
- Turn on scheduled backups (Dokploy → database → **Backups**) once there is real data.

## 2. Create the application

**Create Service → Application**, then:

- **Source:** this GitHub repository, branch `main`. Enable auto-deploy on push if wanted.
- **Build type:** `Dockerfile`, Dockerfile path `Dockerfile`, build context `.` (the repo root).
- **Environment:**

  | Variable           | Value                                   | Notes                                              |
  | ------------------ | --------------------------------------- | -------------------------------------------------- |
  | `DATABASE_URL`     | the internal connection URL from step 1 | required                                           |
  | `PORT`             | `3000`                                  | optional, it's the default                         |
  | `LOG_LEVEL`        | `info`                                  | optional                                           |
  | `MIGRATE_ON_START` | `true`                                  | optional; migrations run on every start by default |

  `NODE_ENV=production` is already set in the image.

## 3. Domain and WebSockets

In the application's **Domains** tab, add the domain (e.g. `pokesurvivor.example.com`):

- **Container port:** `3000`
- **HTTPS:** on, certificate provider Let's Encrypt.

Dokploy routes the domain through Traefik, which proxies WebSocket upgrades without extra
configuration. The client connects to `wss://<domain>/ws` on the same origin, so no CORS or
separate WebSocket domain is needed. Check it by opening the site: the page should show
`server: open` and an RTT.

## 4. Health check and zero-downtime deploys

The image declares a Docker `HEALTHCHECK` that calls `GET /healthz` every 10 s, and Docker Swarm
(which Dokploy uses for applications) honours it. `/healthz` returns `200` with
`{"status":"ok","database":"up"|"down"}` while the process is alive; it deliberately stays `200`
when Postgres is briefly down, so a database restart doesn't also restart the app.

To have Dokploy wait for a healthy container before switching traffic, set these under the
application's **Advanced → Swarm Settings**:

- **Health Check:**
  ```json
  {
    "Test": [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
    ],
    "Interval": 10000000000,
    "Timeout": 3000000000,
    "StartPeriod": 20000000000,
    "Retries": 3
  }
  ```
- **Update Config:** `{"Parallelism": 1, "Order": "start-first", "FailureAction": "rollback"}`

On shutdown Swarm sends `SIGTERM`; the server stops accepting connections, closes open WebSockets
and the database pool, and exits within 10 s. When phase 3 adds draining of running games, raise
the stop grace period to match.

## 5. Verify

```sh
curl https://<domain>/healthz          # {"status":"ok","database":"up"}
curl -I https://<domain>/legacy/       # 200, the old game
```

and open `https://<domain>/` to see the WebSocket RTT.

## Running the image anywhere else

```sh
docker build -t pokesurvivor .
docker run -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host:5432/db pokesurvivor
```

## Migrations

Migrations live in `apps/server/drizzle/` and are applied on start. To apply them by hand
instead (e.g. from a one-off container), set `MIGRATE_ON_START=false` and run
`pnpm db:migrate` with `DATABASE_URL` set.
