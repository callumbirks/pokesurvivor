# Deploying on Dokploy

The whole game is one Docker image: a Node 22 process that serves the client, the HTTP API, the
WebSocket game server (`/ws`) on one port (`PORT`, default
`3000`). The only other service it needs is Postgres.

## Releasing a version

Each deploy is a numbered release (v1, v2, …) that players see in the game: the What's new screen
lists it, and Settings shows the version. Before deploying, on an up-to-date, clean `main`:

```sh
pnpm release --dry-run   # shows the version, its date, PRs and lines; changes nothing
pnpm release             # unreleased → vN, regenerates CHANGELOG.md, commits "Release vN", tags vN
git push --follow-tags   # pushes the commit and the tag; deploy from that commit
```

`pnpm release` moves `unreleased` in `packages/data/changelog.json` into version N+1, dated today
(local time), with the PRs collected there. It doesn't push. It refuses to run when there are no
unreleased lines, when the working tree has uncommitted changes, or when the tag already exists.
To undo a release that hasn't been pushed: `git tag -d vN && git reset --hard HEAD~1`.

How pull requests add lines to `unreleased` is in
[CONTRIBUTING.md](../CONTRIBUTING.md#changelog). A build with unreleased lines shows its version as
e.g. `v7+dev` (`dev` before the first release).

### Versions and the reload prompt

Every image build gets a **build id**. The client build (`apps/client/vite.config.ts`) bakes it
into the bundle and writes it to `apps/client/dist/build.json`; the server in the same image reads
that file at startup and sends the id, with the version label, in the WebSocket `welcome` and in
the `X-Build` header of API responses. A tab still running an older bundle (a deploy happened
since it loaded) sees a different id and shows "Version vN is available. Reload to update": on
the menus straight away, after the run during a run, and again on the next screen or after five
minutes when closed. It never reloads by itself; a `PROTOCOL_VERSION` change still forces a
reload, as before.

The id is unique per build. A build Docker serves from cache (no app or package changed, e.g. a
docs-only commit) keeps its id, so it prompts nobody. To pick the id yourself, set the build
argument `BUILD_ID` (Dokploy: the application's **Build-time Arguments**), e.g. to the commit.
`pnpm dev` has no build id, so development never prompts.

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

  `RESTART_RECONNECT_GRACE_S` defaults to `180`: the reconnect window after a lobby handoff is adopted,
  and the TTL of a handoff nobody has claimed.

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

### Lobby handoff during the overlap

The run drain above is unchanged. Lobby/main-menu rooms now survive a graceful deploy using a
per-room Postgres handoff, which the replacement can adopt **after it is already running**.
Migration 0004 adds `game_rooms` (ownership, expiry and a pending lobby payload) and
`game_room_members` (one reserved room per user).
Migrations still apply automatically on startup. These tables contain no simulation snapshots.

- **Before SIGTERM:** the old instance remains fully live. Players can join, leave, be kicked,
  change readiness or update partners normally while the replacement is booting. No lobby is
  snapshotted at deploy/build start.
- **At SIGTERM:** the old instance freezes lobby/loading rooms against new mutations, waits for
  room requests already in flight, cancels any loading game, and snapshots the final lobby code,
  host, membership, ready/busy state and partners. Publishing the payload and releasing ownership
  happen atomically in Postgres. Only then does it detach the local room and close its clients
  with 1012. Partner refreshes and grace callbacks cannot change a frozen room. Pending invites
  are transient and must be sent again; there are no per-room configurable settings today.
- **Running games:** they keep their original ticks, inputs, choices, leave/kick and disconnect
  behaviour on the old server. When a game ends normally (or at the drain timeout), rewards are
  recorded as before, then its current members' lobby is handed off in the same way. Those
  members are not-ready, as after any run. Players who left or were removed are absent from that
  lobby; their run rewards are still credited normally.
- **A player disconnecting mid-drain:** their in-game slot cannot resume on the replacement,
  exactly as before. The replacement shows a waiting notice and holds their existing room
  reservation, preventing a duplicate room or solo run. It polls only connected users waiting for their room every heartbeat
  (2 s) and adopts their lobby once published, without requiring another reconnect. The old
  server still applies the normal `RECONNECT_GRACE_S` (60 s): if the game has not ended by then,
  that player's membership expires and they are removed/credited for the time played. The
  replacement clears the waiting notice and explains the expiry; they can then choose a new
  room. They are not automatically added back to the original lobby after leaving/expiry.
- **Before adoption on the replacement:** joining a code still owned by the old instance,
  creating another room for a reserved member, or inviting a member still on the old instance
  returns the explicit `room_pending` message. Shared unique room codes and memberships prevent
  competing rooms. Adoption takes a row lock, consumes the payload once, and keeps only members
  whose current reservation still belongs to it; it does not overwrite a newer room or reapply
  an old snapshot after membership changes on the new server.

Handed-off rooms nobody claims expire after `RESTART_RECONNECT_GRACE_S` (default 180 s), including
while no replacement is running; expired rows are never adopted. The same fresh 180 s window
starts on adoption for members who have not reconnected. Normal cleanup removes absent members,
transfers the host, and closes empty rooms. A consumed payload is cleared while the shared
ownership/membership reservations remain for the live room. Live reservations are renewed by
the owner every heartbeat in one batch, and expire after 30 seconds if that process disappears.
Expired memberships stop blocking solo immediately; create/join reclaim their expired reservations
on demand, without waiting for cleanup. These reservations are not a crash-safe room save.
Graceful handoff writes must succeed before clients are released.

Global expiry cleanup runs at startup and then about every 30 seconds. Background renewal, cleanup
and waiting-member polling run outside the lobby request queue; only the brief in-memory attachment
after a successful adoption is serialized with lobby mutations. Slow maintenance queries therefore
do not delay local readiness/leave requests or the game ticker. Actions needing their own DB queries
(create/join, for example) still require the database to respond.

Authentication uses the existing persisted login cookie; no new resume token is needed. Clients
retain their lobby UI, show “Reconnecting…”, and retry with jittered exponential backoff (500 ms
to 10 s) for up to three minutes. A stalled connection/hello retries in 10 s. A protocol-version
mismatch stops retries and shows Reload, including over a game. Reloading obtains the current
client and rejoins the handed-off lobby if its reservation has not expired. The two waiting
notices are additive; protocol v7 is unchanged.

Keep **one replica** with `start-first` updates; brief deploy overlap is supported, arbitrary
active multi-replica routing is not. Keep the **16-minute stop grace** for the default 900 s drain. For plain Docker use `--stop-timeout 960`; for an app in Compose use
`stop_grace_period: 16m`. The repository's Compose file only starts the development database.
Dockerfile `STOPSIGNAL SIGTERM` specifies the signal, not its grace period.

The first deploy from the old version cannot preserve its lobbies, because that version does not
publish handoffs. Subsequent graceful deploys do. Host crashes and SIGKILL are outside this scope;
run recording retains its existing database retries and failure limitations.

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
docker run --stop-timeout 960 -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host:5432/db pokesurvivor
```

## Migrations

Migrations live in `apps/server/drizzle/` and are applied on start. To apply them by hand
instead (e.g. from a one-off container), set `MIGRATE_ON_START=false` and run
`pnpm db:migrate` with `DATABASE_URL` set.
