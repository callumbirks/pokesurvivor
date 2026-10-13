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

  | Variable                   | Value                                     | Notes                                                                                                                                        |
  | -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
  | `DATABASE_URL`             | the internal connection URL from step 1   | required                                                                                                                                     |
  | `PORT`                     | `3000`                                    | optional, it's the default                                                                                                                   |
  | `LOG_LEVEL`                | `info`                                    | optional                                                                                                                                     |
  | `MIGRATE_ON_START`         | `true`                                    | optional; migrations run on every start by default                                                                                           |
  | `LEADERBOARD_TIME_ZONE`    | your IANA time zone, e.g. `Europe/London` | recommended; when daily/weekly leaderboards reset. Set it to your own time zone; the default `Europe/Madrid` is only the original operator's |
  | `AUTH_RATE_LIMIT_MAX`      | `10`                                      | optional; login and register attempts per IP per minute                                                                                      |
  | `ACTION_RATE_LIMIT_MAX`    | `60`                                      | optional; run starts, checkpoints and friend requests per IP per minute                                                                      |
  | `COOKIE_SECURE`            | `true`                                    | optional; defaults to true when `NODE_ENV=production` (the image sets it)                                                                    |
  | `DRAIN_TIMEOUT_S`          | `900`                                     | optional; how long running games may finish on a deploy (see §4)                                                                             |
  | `RUN_CHECKPOINT_TIMEOUT_S` | `3600`                                    | optional; an unreported solo run is credited from its last checkpoint after this ([api.md](api.md#checkpoints-and-the-timeout-credit))       |
  | `RUN_SWEEP_INTERVAL_S`     | `60`                                      | optional; how often the server looks for such runs                                                                                           |
  | `SNAPSHOT_HZ`              | `20`                                      | optional; snapshots per second per client (max 30)                                                                                           |
  | `CHOICE_TIMEOUT_S`         | `30`                                      | optional; coop level-up/item/bond choices resolve by themselves after this                                                                   |
  | `RECONNECT_GRACE_S`        | `60`                                      | optional; how long a dropped player's place is kept                                                                                          |
  | `LOADING_TIMEOUT_S`        | `15`                                      | optional; members who haven't loaded by then are dropped from the game                                                                       |

  `NODE_ENV=production` is already set in the image.

## 3. Domain and WebSockets

In the application's **Domains** tab, add the domain (e.g. `pokesurvivor.example.com`):

- **Container port:** `3000`
- **HTTPS:** on, certificate provider Let's Encrypt.

Dokploy routes the domain through Traefik, which proxies WebSocket upgrades without extra
configuration. The client connects to `wss://<domain>/ws` on the same origin, so no CORS or
separate WebSocket domain is needed (the session cookie authenticates the upgrade). Check it by
opening the site: it should show the login screen. The protocol is described in
[protocol.md](protocol.md).

## 4. Health check and zero-downtime deploys

The image declares a Docker `HEALTHCHECK` that calls `GET /healthz` every 10 s, and Docker Swarm
(which Dokploy uses for applications) honours it. `/healthz` returns `200` with
`{"status":"ok","database":"up"|"down"}` while the process is alive; it deliberately stays `200`
when Postgres is briefly down, so a database restart doesn't also restart the app.

Swarm uses the image's health check (interval 10 s, timeout 3 s, start period 20 s, 3 retries)
automatically, so there is nothing to configure for it. **Leave the Health Check field under
Advanced → Swarm Settings empty.** Dokploy stores the `Test` array you paste there as a single
JSON-encoded string (`["[\"CMD\",\"node\",...]"]`), which isn't a command Docker can run. The
health check then never runs, every task stays `Starting`, the service name never resolves on
`dokploy-network`, and Traefik answers **502 Bad Gateway** (see
[Troubleshooting](#troubleshooting-bad-gateway)).

To have Dokploy wait for a healthy container before switching traffic, set this under the
application's **Advanced → Swarm Settings**:

- **Update Config:** `{"Parallelism": 1, "Order": "start-first", "FailureAction": "rollback"}`

### Replicas: keep 1

Keep the application at **1 replica**. Rooms and coop games live in the server's memory, so with
more than one replica players who want to play together can land on different instances and never
see each other. The brief overlap of two containers during a `start-first` deploy is fine: the old
one drains (below) and takes no new rooms.

### Deploys while people are playing

Coop games run in the server's memory, so a deploy must not kill them. On `SIGTERM` the server
**drains**: it stops creating rooms and games, tells every client the server is updating, and
sends lobby clients to reconnect, which with `start-first` reaches the new container. It lets
running games finish for up to `DRAIN_TIMEOUT_S` (default 900 s = 15 min), then ends the rest and
credits their players. Finally it closes the sockets and the database pool and exits. It gives up
`DRAIN_TIMEOUT_S + 15 s` after the signal. The drain ends early once the last game is over.

Docker's default stop grace period is **10 s**, after which the container is killed (`SIGKILL`)
and running games are lost without being credited. Raise it above the drain timeout, e.g.
**16 minutes** for the default 900 s:

- If your Dokploy version has **Stop Grace Period** under **Advanced → Swarm Settings**, set it
  there (`960s`, or `960000000000` if it asks for nanoseconds).
- Otherwise set it on the Swarm service by hand:
  `docker service update --stop-grace-period 16m <service>` (the service name is the app's
  name in Dokploy). Check that it survives a redeploy (`docker service inspect <service>`,
  `StopGracePeriod`). Dokploy may recreate the service spec. If it doesn't survive, lower
  `DRAIN_TIMEOUT_S` to fit what you can set.

With `start-first` updates the new container is serving before the old one gets `SIGTERM`, so
new and reconnecting clients go to the new one while the old one finishes its games. A player who
drops during the drain reconnects to the new instance and can't resume the old game (rooms live
in memory), but is still credited when it ends.

## 5. Verify

```sh
curl https://<domain>/healthz          # {"status":"ok","database":"up"}
curl -I https://<domain>/legacy/       # 200, the old game
```

and open `https://<domain>/`: it should show the login screen. Log in and start a game to check
that the WebSocket connects.

## Troubleshooting: Bad Gateway

If Traefik answers `502 Bad Gateway`, check on the Dokploy host (`<app>` is the app's name in
Dokploy, which is also the Swarm service name):

1. Are the tasks healthy?

   ```sh
   docker service ps <app> --format '{{.Name}} {{.CurrentState}} {{.DesiredState}} {{.Error}}'
   ```

   Tasks stuck in `Starting` (often several piled up, because of `start-first`) never became
   healthy, so Swarm never adds them to the service's DNS name.

2. Which health check did the container actually get?

   ```sh
   docker inspect <container> --format '{{json .Config.Healthcheck}} {{json .State.Health}}'
   ```

   It should be the image's `["CMD","node","-e","fetch(...)"]`. A `Test` with one JSON-encoded
   string in it, or a `State.Health` of `null`, means the Dokploy Health Check field overrode it
   (see §4).

3. Can Traefik reach the app?

   ```sh
   docker exec dokploy-traefik wget -qO- http://<app>:3000/healthz
   ```

   `wget: bad address` means the service name doesn't resolve on `dokploy-network`, which is what
   happens while no task is healthy.

**Fix:** clear the Health Check field under **Advanced → Swarm Settings**, remove the service so
the stale spec goes away (`docker service rm <app>`), and redeploy from Dokploy.

## Running the image anywhere else

```sh
docker build -t pokesurvivor .
docker run -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host:5432/db pokesurvivor
```

## Migrations

Migrations live in `apps/server/drizzle/` and are applied on start. To apply them by hand
instead (e.g. from a one-off container), set `MIGRATE_ON_START=false` and run
`pnpm db:migrate` with `DATABASE_URL` set.
