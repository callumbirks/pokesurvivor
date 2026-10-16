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
  | `UPDATE_WARNING_S`         | `30`                                      | optional; on a deploy, players get this long a warning before the server saves coop games and stops (see §4)                                 |
  | `RESTORE_GRACE_S`          | `60`                                      | optional; a coop game restored after a deploy waits this long for its players before it resumes without the missing                          |
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

## 4. Health check and deploys

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

Deploys are **stop-first**: the old container stops (after warning players and saving running
coop games) before the new one starts, so two versions never serve players at the same time.
Set both of these under the application's **Advanced → Swarm Settings**:

- **Update Config:** `{"Parallelism": 1, "Order": "stop-first", "FailureAction": "rollback"}`
- **Stop Grace Period:** `60s` (`60000000000` if it asks for nanoseconds). If your Dokploy version
  doesn't have the field, set it on the service by hand:
  `docker service update --stop-grace-period 60s <service>` (the service name is the app's name in
  Dokploy), and check that it survives a redeploy (`docker service inspect <service>`,
  `StopGracePeriod`).

The grace period must be comfortably above `UPDATE_WARNING_S` (30 s) plus the time to save games,
hand over lobbies and close (normally under a second; the server gives itself 20 s and exits by
itself `UPDATE_WARNING_S + 20 s` after `SIGTERM`). Docker's default is **10 s**: with it, Swarm
kills the server (`SIGKILL`) before it has saved anything, and the coop runs in progress are lost
without being credited. If you raise `UPDATE_WARNING_S`, raise the grace period with it.

For plain Docker use `--stop-timeout 60`; for an app in Compose, `stop_grace_period: 60s`. The
repository's Compose file only starts the development database. Dockerfile `STOPSIGNAL SIGTERM`
specifies the signal, not its grace period.

### Replicas: keep 1

Keep the application at **1 replica**. Rooms and coop games live in the server's memory, so with
more than one replica players who want to play together can land on different instances and never
see each other.

### Deploys while people are playing

Coop games run in the server's memory. On `SIGTERM` the server:

1. **Warns everyone** (`UPDATE_WARNING_S`, default 30 s). Every connected player gets a banner with
   a live timer: "Server update in 0:30 · your run will continue right after" in a coop run,
   "Server update in 0:30" in the menus and lobbies, and "… · your solo run isn't affected" in a
   solo run (solo runs are simulated in the browser; only their checkpoint uploads pause while
   the server is down, and they retry). Coop runs **keep playing** during the countdown. Nobody
   can create a room, join one or start a game meanwhile (`server_draining`, "server updating");
   a game still loading is called off and its players go back to their lobby.
2. **Saves every running coop game** at the end of the countdown: it freezes them and writes, in
   one transaction, a row per game to `game_saves` (migration 0006: the sim state as JSON text,
   the room and its members, the player slots, who was present, the run's static info, and each
   player's result as of the save), and releases their room reservations for the next server.
   Their players are sent to reconnect (close code 1012).
3. **Hands over lobbies** as before (`game_rooms`, below), including those of games that ended
   during the countdown, once their results are recorded.
4. Closes the sockets and the database pool and exits.

The new server, at startup and **before it accepts connections**, claims every saved game (each
row is deleted as it is claimed) and restores it **paused**, waiting for its players:

- Clients reconnect by themselves (the "Reconnecting…" notice) and get the game again from a full
  snapshot. They see "Waiting for <names> · 0:42" while someone is missing.
- As soon as everyone who was in the game is back, or after `RESTORE_GRACE_S` (60 s from the
  server's start), the game resumes after a **3-2-1** countdown ("Resuming in 3…").
- Players not back by then are treated exactly like a disconnect: they keep their place for
  `RECONNECT_GRACE_S` (60 s), and are removed (and credited for what they earned) after that.
- Pending level-up / item / bond choices and their timers come back as they were: choice timers
  count sim ticks, and the sim stands still while the game waits.

**If a saved game can't be restored** (an incompatible change to the sim, a row from a newer
server, a damaged row), the server logs `could not restore a saved game; crediting it as saved`
with the game and room ids, and ends it like the old drain timeout did: through the normal
crediting (`recordCoopRun`, the same rewards, missions and achievements), with every player's
result as of the save and reason `server-shutdown`. Its players get the results when they
reconnect, and their lobby back. If saving fails at shutdown (the database is down), the games are
ended and credited on the spot instead, as the drain timeout used to.

**Downtime.** About 30 s of warning while everything still works, then the server is down until
the new container is healthy: the new container starts in a few seconds, and Swarm routes to it at
its first passing health check (up to ~10 s), so expect roughly **10–20 s** without a server.
Players see "Reconnecting…" (clients retry for three minutes) and then carry on: coop runs after
the 3-2-1, lobbies as they were.

`SIGINT` (Ctrl-C in development) skips the countdown and saves at once, so `pnpm dev` restarts
keep coop games too.

If a deploy happens to run `start-first` anyway (the setting was missed), nothing is lost: the
saved games are restored by the already-running new server when their players reconnect to it.
But the two versions then overlap during the countdown, which is what stop-first avoids.

### Moving to stop-first: the first deploy of this change

Production before this change runs **v15**: `start-first`, a 16-minute stop grace, and the
15-minute drain (running coop games finish on the old container, which credits them). v15 can't
save games, so the deploy that brings this change in must still let v15 drain. Do it in this order:

1. **Don't change the Swarm settings yet.** Keep `"Order": "start-first"` and the 16-minute stop
   grace for this one deploy. (Switching first would be worse either way: with stop-first and a
   60 s grace, v15 starts its drain and Swarm kills it after 60 s, losing the coop runs in
   progress without credit; with stop-first and the 16-minute grace, nothing serves players for
   up to 15 minutes while v15 drains.)
2. **Deploy the release at a quiet time**, ideally with no coop runs going. The new container
   starts and becomes healthy; v15 gets `SIGTERM` and drains as before: its lobbies move to the
   new server, its running coop games finish there (up to 15 minutes) and are credited by v15.
   That's safe: this release doesn't change the save format (still version 3), so v15 can
   credit them. The new server has no saved games to restore this time.
3. **Wait until the old container is gone:**
   `docker service ps <app> --format '{{.Name}} {{.CurrentState}} {{.DesiredState}}'` shows only
   one task `Running` (the old one `Shutdown`).
4. **Switch to stop-first:** Update Config `{"Parallelism": 1, "Order": "stop-first",
"FailureAction": "rollback"}` and Stop Grace Period `60s` (above). If saving the settings
   redeploys the app, that's already a stop-first deploy of the new version: coop runs get the
   warning and continue on the new container. Remove `DRAIN_TIMEOUT_S` from the environment if
   you set it; it is no longer read.
5. Every deploy after that is stop-first.

The blank-screen fix (PR #92: `no-store` on errors and the client's reload-once) ships in the
same release. During this last `start-first` overlap the old v15 container still answers missing
assets without `no-store`, so a browser can still get a cached 404 from it once; the new
`index.html`'s recovery retries past the cache and reloads, and a hard refresh fixes anything
left. Optionally purge Cloudflare's cache after step 3 (see below). From then on stop-first means
there's no overlap at all.

### Lobby handoff

Lobby/main-menu rooms survive a deploy using a per-room Postgres handoff that the next server
adopts. Migration 0004 adds `game_rooms` (ownership, expiry and a pending lobby payload) and
`game_room_members` (one reserved room per user). Migrations still apply automatically on startup.
Running games don't use this payload: they are saved to `game_saves` (above).

- **During the countdown:** lobby/loading rooms are frozen against new mutations; a loading game is
  cancelled. Requests already in flight finish first. Partner refreshes and grace callbacks cannot
  change a frozen room.
- **At the end of the countdown:** the server snapshots the final lobby code, host, membership,
  ready/busy state and partners. Publishing the payload and releasing ownership happen atomically
  in Postgres. Only then does it detach the local room and close its clients with 1012. Pending
  invites are transient and must be sent again; there are no per-room configurable settings today.
- **A game that ended during the countdown:** its results are recorded as usual, then its current
  members' lobby is handed off the same way. Those members are not-ready, as after any run.
- **On the next server:** a member's lobby is adopted when they connect (or by polling, every
  heartbeat, for a connected member still waiting for it). Joining a code still owned by another
  live instance, creating another room for a reserved member, or inviting a member reserved there
  returns `room_pending`; the waiting member sees a notice. Adoption takes a row lock, consumes
  the payload once, and keeps only members whose current reservation still belongs to it.

Handed-off rooms nobody claims expire after `RESTART_RECONNECT_GRACE_S` (default 180 s), including
while no new server is running; expired rows are never adopted. The same fresh 180 s window starts
on adoption for members who have not reconnected. Normal cleanup removes absent members, transfers
the host, and closes empty rooms. Live reservations are renewed by the owner every heartbeat in one
batch, and expire after 30 seconds if that process disappears (a crash: then the room and any game
in it are lost; only graceful stops save games). Expired memberships stop blocking solo
immediately; create/join reclaim their expired reservations on demand. A saved game's room is
taken back by the server that restores it, and made again if its reservation expired meanwhile.

Global expiry cleanup runs at startup and then about every 30 seconds. Background renewal, cleanup
and waiting-member polling run outside the lobby request queue, so slow maintenance queries do not
delay local readiness/leave requests or the game ticker.

Authentication uses the existing persisted login cookie; no new resume token is needed. Clients
retain their lobby UI, show “Reconnecting…”, and retry with jittered exponential backoff (500 ms
to 10 s) for up to three minutes. A stalled connection/hello retries in 10 s. A protocol-version
mismatch stops retries and shows Reload, including over a game. Reloading obtains the current
client and rejoins the handed-off lobby if its reservation has not expired. The notices are
additive; protocol v7 is unchanged.

### Caching behind Cloudflare

The site can sit behind Cloudflare (production does). What the server sends:

| Response                                                   | `Cache-Control`                       |
| ---------------------------------------------------------- | ------------------------------------- |
| `index.html`, `build.json`, fonts and other unhashed files | `no-cache` (revalidated every time)   |
| Vite's fingerprinted files under `/assets/`                | `public, max-age=31536000, immutable` |
| Sprite sheets under `/sprites/` (busted by a query string) | `public, max-age=31536000, immutable` |
| **Any error** (status ≥ 400): a missing asset, API errors  | `no-store`                            |

The last row matters for deploys. During a `start-first` overlap (before stop-first deploys, and
the one transition deploy above) Traefik sends requests to either container, so a browser that got the **new** `index.html` can have its
`/assets/index-<new hash>.js` answered by the **old** container with a 404. Cloudflare gives a
response without `Cache-Control` its Browser Cache TTL (`max-age=14400`), and caches 404s at the
edge for a few minutes by default, so that 404 used to stick: a black or white page that F5
didn't fix, only a hard refresh (v15). Cloudflare leaves `no-store` alone, so errors are no
longer cached anywhere. Check it with
`curl -sI https://<domain>/assets/does-not-exist.js`: `cache-control: no-store`, and
`cf-cache-status` not `HIT`.

The client also recovers by itself (`apps/client/src/load-recovery.ts`, run inline in
`index.html`): when the main bundle, a lazy chunk or the solo worker fails to load (a tab left
open across a deploy asks for chunks that are gone), it refetches the failed file past the browser
cache and reloads, once per two minutes per tab; a second failure shows "Couldn't load the game.
Please hard-refresh the page" instead of a blank page.

**Optional:** purge Cloudflare's cache after a deploy (Caching → Configuration → Purge
Everything, or the API) to drop anything cached at the edge before this fix. Hashed assets are
cheap to refetch, so purging costs little. Old hashed files are not kept across deploys, so a tab
from before the deploy that lazy-loads one reloads into the new version (above).

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

   Tasks stuck in `Starting` (several can pile up as Swarm retries) never became
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
docker run --stop-timeout 60 -p 3000:3000 -e DATABASE_URL=postgres://user:pass@host:5432/db pokesurvivor
```

## Migrations

Migrations live in `apps/server/drizzle/` and are applied on start. To apply them by hand
instead (e.g. from a one-off container), set `MIGRATE_ON_START=false` and run
`pnpm db:migrate` with `DATABASE_URL` set.

## Live tuning

`tuning.json` and `levelup.json` can be tuned on the live server, without a deploy, from the
admin page at `https://<domain>/#admin` (there is no link to it; for anyone who isn't an admin
the route doesn't exist and every admin endpoint answers 404). A save publishes a new config
version at once: every run that starts after it plays with it, and runs already going keep the
version they started with (a coop game saved for a deploy too). The API is in
[api.md](api.md#live-tuning-admin).

**Make someone an admin** (in the Postgres service's console, or `psql "$DATABASE_URL"`):

```sql
UPDATE users SET is_admin = true WHERE lower(username) = lower('Ash');
-- and to take it away again:
UPDATE users SET is_admin = false WHERE lower(username) = lower('Ash');
```

It applies on their next request (the client reads it at login or on reload).

**Bake the overrides into the repo.** Live overrides sit on top of the JSON files, which stay
the source of truth. Once a tuning is settled:

1. On `#admin`, **Export as patch** downloads `tuning-patch-v<N>.json` (the overrides in effect).
2. In the repo: `pnpm --filter @pokesurvivor/tools apply-tuning-patch path/to/tuning-patch-vN.json`
   rewrites the changed values in `packages/data/json/tuning.json` and `levelup.json` (nothing
   else in them), formats them and validates them (`--dry-run` only prints the changes). Commit,
   with a changelog line, and deploy as usual.
3. After that deploy, **Revert to the defaults** on `#admin` (version 0's row in the history).
   The defaults now hold the tuned values, so new runs play exactly as before; until then the
   overrides would keep masking later edits to those settings in the JSON.

**After a deploy**, a stored override may name a setting the new build removed, or a value its
schema no longer accepts. The server starts anyway: those settings are skipped (runs use their
defaults), logged as a warning (`config version has overrides this build skips`), and listed at
the top of `#admin`. Publishing again (or reverting) stores only what applies.

Overrides replace whole arrays (a curve or the list of stat cards), so an override of an array
also hides changes a deploy makes to that array's defaults: check the diff against the defaults
on `#admin` after deploying data changes.
