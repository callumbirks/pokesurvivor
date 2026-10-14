# Deploying on Dokploy

The whole game is one Docker image: a Node 22 process that serves the client, the HTTP API, the
WebSocket game server (`/ws`) on one port (`PORT`, default
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

  | Variable                    | Value                                     | Notes                                                                                                                                        |
  | --------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
  | `DATABASE_URL`              | the internal connection URL from step 1   | required                                                                                                                                     |
  | `PORT`                      | `3000`                                    | optional, it's the default                                                                                                                   |
  | `LOG_LEVEL`                 | `info`                                    | optional                                                                                                                                     |
  | `MIGRATE_ON_START`          | `true`                                    | optional; migrations run on every start by default                                                                                           |
  | `LEADERBOARD_TIME_ZONE`     | your IANA time zone, e.g. `Europe/London` | recommended; when daily/weekly leaderboards reset. Set it to your own time zone; the default `Europe/Madrid` is only the original operator's |
  | `AUTH_RATE_LIMIT_MAX`       | `10`                                      | optional; login and register attempts per IP per minute                                                                                      |
  | `ACTION_RATE_LIMIT_MAX`     | `60`                                      | optional; run starts, checkpoints and friend requests per IP per minute                                                                      |
  | `COOKIE_SECURE`             | `true`                                    | optional; defaults to true when `NODE_ENV=production` (the image sets it)                                                                    |
  | `RESTART_RECONNECT_GRACE_S` | `180`                                     | optional; reconnect window after restored lobbies boot (see §4)                                                                              |
  | `RUN_CHECKPOINT_TIMEOUT_S`  | `3600`                                    | optional; an unreported solo run is credited from its last checkpoint after this ([api.md](api.md#checkpoints-and-the-timeout-credit))       |
  | `RUN_SWEEP_INTERVAL_S`      | `60`                                      | optional; how often the server looks for such runs                                                                                           |
  | `SNAPSHOT_HZ`               | `20`                                      | optional; snapshots per second per client (max 30)                                                                                           |
  | `CHOICE_TIMEOUT_S`          | `30`                                      | optional; coop level-up/item/bond choices resolve by themselves after this                                                                   |
  | `RECONNECT_GRACE_S`         | `60`                                      | optional; how long a dropped player's place is kept                                                                                          |
  | `LOADING_TIMEOUT_S`         | `15`                                      | optional; members who haven't loaded by then are dropped from the game                                                                       |

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

## 4. Health check and restart-safe deploys

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

To save rooms before the replacement server starts, set this under the
application's **Advanced → Swarm Settings**:

- **Update Config:** `{"Parallelism": 1, "Order": "stop-first", "FailureAction": "rollback"}`
- **Rollback Config:** `{"Parallelism": 1, "Order": "stop-first"}`

### Replicas: keep 1

Keep the application at **1 replica**. The live rooms still belong to one server process.
Restart checkpoints in Postgres are a handoff between consecutive instances, not shared live state.
**Change any existing `start-first` update setting to `stop-first`**, including rollbacks: the old
server must save before the new one restores. `start-first` and multiple replicas are unsupported
and can lose rooms or overwrite a checkpoint. There is a brief outage during the replacement;
connected clients show “Reconnecting…” and retry automatically.

### Deploys while people are playing

On `SIGTERM` (and `SIGINT`) the server rejects new HTTP and WebSocket work, freezes its game loop
and room timers, and waits for requests already in flight. **Active coop runs do not resume.**
They end immediately with reason `server-shutdown`, using the normal results/reward recording
path, then their members return to the same lobby as not-ready. A game still loading is cancelled
without creating run rewards. Solo games continue locally, as before.

The server then writes a small, atomic Postgres checkpoint (`room_restart_state`, migration 0004)
and closes sockets. On boot, it restores each lobby's code, members, host, ready/busy status and
partner, before accepting connections. There are currently no per-room configurable settings.
Pending invites are transient and must be sent again. Authentication uses the existing persisted
login session cookie; no new resume token is needed. Players have `RESTART_RECONNECT_GRACE_S`
(default 180 s) from boot to reconnect. Normal membership cleanup removes absent players,
transfers the host when needed and deletes empty rooms. Subsequent ordinary disconnects use
`RECONNECT_GRACE_S` (default 60 s).

The checkpoint is consumed on successful boot so a later crash cannot replay an old lobby after
its players have left or finished another run. **This protects graceful restarts, not a host crash
or `SIGKILL`.** There is no periodic checkpoint. Run recording retains its existing DB retries;
a persistent database outage can still prevent rewards from being credited. A failed checkpoint
write makes shutdown fail rather than claiming rooms were saved.

The process gives shutdown **30 seconds** total. Docker's default stop grace is only **10 seconds**,
so configure **45 seconds** (or retain a longer existing setting):

- If Dokploy exposes **Stop Grace Period** under **Advanced → Swarm Settings**, set `45s`
  (or `45000000000` if it asks for nanoseconds).
- Otherwise set the service with `docker service update --stop-grace-period 45s <service>`.
  Check `docker service inspect <service>` after redeploy: Dokploy may recreate the service spec.
- Dockerfile `STOPSIGNAL SIGTERM` specifies the signal, not its grace period. For plain Docker,
  use `docker run --stop-timeout 45 ...`; for an app in Compose use `stop_grace_period: 45s`.
  The repository's Compose file runs only the local development database.

`DRAIN_TIMEOUT_S` is obsolete and can be removed from Dokploy's environment. The old 15-minute
drain is gone. The first deploy of this change cannot restore rooms from the old server, because
that version does not write a checkpoint; subsequent graceful deploys preserve them.

The client retries with jittered exponential backoff (500 ms to 10 s), for up to three minutes,
while retaining its room and showing “Reconnecting…”. A connection/hello that stalls is retried
in 10 s. If a deploy changes `PROTOCOL_VERSION`, the existing mismatch close stops retries and
shows a Reload button, including over an active game. Reloading gets the current client and
rejoins the preserved lobby using the same cookie. This change does not alter protocol shapes or
bump protocol v7. Future changes to the saved room schema must migrate its format or preserve
backward compatibility; an unsupported checkpoint format refuses boot rather than dropping rooms.

Docker references: [update/rollback order](https://docs.docker.com/reference/compose-file/deploy/#update_config),
[stop grace period](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).

## 5. Verify

```sh
curl https://<domain>/healthz          # {"status":"ok","database":"up"}
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
docker run --stop-timeout 45 -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host:5432/db pokesurvivor
```

## Migrations

Migrations live in `apps/server/drizzle/` and are applied on start. To apply them by hand
instead (e.g. from a one-off container), set `MIGRATE_ON_START=false` and run
`pnpm db:migrate` with `DATABASE_URL` set.
