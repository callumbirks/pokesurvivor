# Game protocol (WebSocket)

Coop is server-authoritative: the server runs `packages/sim` for every room at 30 Hz. Clients
send inputs and intents and get snapshots back. Everything goes over one WebSocket per user at
`/ws` on the site's origin (`wss://` behind Traefik in production). There is no WebRTC and no
host browser.

The types are in `packages/protocol` (`messages.ts`, `validate.ts`, `tables.ts`, `wire.ts`). The
client side is `packages/netclient`, which the browser and the bot tests share. The server is in
`apps/server/src/game/`. `PROTOCOL_VERSION` is **7**. Version 3 added the enemies' behaviour column, buff stacks in
`details` and the viewer's `self`. Version 4 added `gameId` to `input` and `intent`. Version 5
adds remaining shield HP as enemy column 14 (index 13), rounded up to whole points. The enemy
table width changes from 13 to 14, so this is breaking: deploy client and server together.
Version 6 added the manual aim, `aim`, to `input`. Version 7 added fire held, `fire`, to
`input`. Within version 7, `self` gained an optional `momentum` (additive: older clients ignore
it, and clients read a missing one as 0), and the JSON part an optional `stats` (the viewer's
stats panel; older clients ignore it, and clients without one show no panel), and the client message
`game.spectate` (spectating while down; a new message type, so nothing older sends it).

## Connection

1. **Upgrade.** The browser sends the `ps_session` cookie with the upgrade, as for HTTP. If there
   is no valid session, the server sends `error {code: "unauthenticated"}` and closes with 4401.
2. **Hello.** The client sends `{type: "hello", protocolVersion}` first, within 5 s. If the
   version differs, the server sends `error {code: "version_mismatch"}` and closes with 4426, and
   the client should reload the page. Otherwise it replies with `welcome`, followed by `room`
   (your room, or null), any pending `invite`s, and `presence` (all your friends).
   In a deployed server, `welcome` also carries `build` (the deploy's build id) and `version`
   (its label, e.g. `v10`). A client whose own build id differs is an old (or newer) bundle that
   still speaks the protocol: it offers a reload without forcing one. Both fields are optional
   and absent in development; a client without a build id ignores them.
3. **One socket per user.** A second hello from the same user **supersedes** the first. The old
   socket gets `error {code: "superseded"}` and is closed with 4409. It must not reconnect,
   otherwise two tabs would keep taking the session from each other.
4. **Heartbeat.** The client sends `ping {id, sentAt}` every `heartbeatMs` (2 s, from `welcome`)
   and the server answers `pong {id, sentAt, serverTime}`. RTT is `now − sentAt`. The server
   closes sockets that have sent nothing for 5 heartbeats (4408). The client drops the socket
   and reconnects if it has heard nothing for 3 heartbeats.
5. **Reconnect.** `NetClient` reconnects with backoff from 0.5 s, doubling to 10 s with ±25%
   jitter. It doesn't reconnect after 4401, 4409 or 4426 (`FINAL_CLOSE_CODES`). On 1012 (server
   restarting) it reconnects to the replacement instance. Retries stop after three minutes
   (`reconnectTimeoutMs`); a stalled connection/hello is retried after 10 s.

**Limits.** Client messages are JSON text of at most 4 KB (larger ones close the socket with 1009).
The rate limit is 60 messages/s sustained with a burst of 120: messages over it are dropped, and
after 300 drops the socket is closed with 4429. Every message is validated exactly (unknown fields
are rejected too). An invalid request gets `reply {ok: false, error: {code: "bad_request"}}`, and
after 20 invalid messages the socket is closed with 4400.

| Close code | Meaning                          | Client reconnects? |
| ---------- | -------------------------------- | ------------------ |
| 1009       | message too large                | yes                |
| 1012       | server restarting (deploy)       | yes                |
| 4400       | protocol error / no hello in 5 s | yes                |
| 4401       | not logged in                    | **no**             |
| 4408       | heartbeat timeout                | yes                |
| 4409       | superseded by another socket     | **no**             |
| 4426       | protocol version mismatch        | **no** (reload)    |
| 4429       | rate limited                     | yes                |

## Messages

### Client → server

| Message                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello {protocolVersion}`                               | first message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ping {id, sentAt}`                                     | heartbeat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `input {gameId, seq, moveX, moveY, slot?, aim?, fire?}` | while playing, sampled at up to 30/s; sent on change or every 250 ms while active (once with neutral movement on a choice pause). `seq` counts from 1 in each game. Movement is clamped to [−1, 1] and persists. `slot` is a one-shot move switch. `aim`: manual aim, an integer in [0, 256) for the angle × 256 / 2π (`encodeAim` / `decodeAim`); absent means auto-aim. Like movement it persists, so it's in every input while manual aim is on. `fire: true`: fire held (only with `aim`; absent while not held) |
| `game.loaded {gameId}`                                  | assets loaded (during `loading`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `game.resync {gameId}`                                  | the client couldn't apply a snapshot; the next one must be full                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `game.spectate {gameId, target}`                        | while down in coop: centre your snapshots' interest area on another player (`target`: their user id), or on yourself again (`null`); see "Spectating" under [Snapshots](#snapshots)                                                                                                                                                                                                                                                                                                                                  |
| `activity {solo: {runId, elapsedS, paused} \| null}`    | your solo run's clock, for friends' presence (see [Friend activity](#friend-activity))                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `room.create {rid}`                                     | → `RoomView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `room.invite {rid, username}`                           | online friends only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `room.join {rid, roomId}`                               | accepts an invite (you must have one) → `RoomView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `invite.decline {rid, roomId}`                          | the owner gets `invite.declined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `room.leave {rid}`                                      | mid-run too: you leave the game and are credited for what you earned                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `room.kick {rid, userId}`                               | owner only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `room.status {rid, status}`                             | `ready` / `not-ready` / `busy` (set `busy` in the gacha, shop, collection or settings)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `room.start {rid}`                                      | owner only, when every member is ready                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `intent {rid, gameId, intent}`                          | the sim's `Intent` (`pickCard`, `pickItem`, `pickBond`, `reroll`, `cycleSlot`, …)                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Requests carry a request id `rid` and get `reply {rid, ok: true, data?}` or
`reply {rid, ok: false, error: {code, message}}`. Intents are validated generically, because the
sim adds new ones: a `type` plus up to 8 fields that are short strings, finite numbers, booleans,
null, or arrays of up to 8 of those. The sim then checks each field and rejects unknown types,
so new intents need no protocol change.

Error codes: `bad_request`, `not_in_room`, `already_in_room`, `not_owner`, `room_busy` (the
game already started), `room_full`, `already_member`, `no_invite`, `user_not_found`,
`not_friends`, `not_online`, `not_ready` (the message names who blocks), `no_partner`,
`server_draining`, `not_playing`, `intent_rejected` (the sim's reason in `message`), `internal`.

### Server → client

| Message                                                                                            | When                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `welcome {userId, username, serverTime, heartbeatMs, draining, protocolVersion, build?, version?}` | after hello                                                                                                                                                        |
| `pong {id, sentAt, serverTime}`                                                                    | each ping                                                                                                                                                          |
| `reply {rid, ok, data? \| error}`                                                                  | each request                                                                                                                                                       |
| `error {error}`                                                                                    | before the server closes the socket (unauthenticated, superseded, version mismatch)                                                                                |
| `room {room: RoomView \| null}`                                                                    | your room after **every** change (it's state: the latest one wins)                                                                                                 |
| `invite {roomId, from, expiresAt}`                                                                 | you were invited (expires in 2 min)                                                                                                                                |
| `invite.revoked {roomId}`                                                                          | the invite expired, or the room started or closed                                                                                                                  |
| `invite.declined {roomId, username}`                                                               | to the owner                                                                                                                                                       |
| `presence {friends: [{username, status, activity?}]}`                                              | on connect                                                                                                                                                         |
| `presence.update {username, status, activity?}`                                                    | a friend's presence or activity changed (see [Friend activity](#friend-activity))                                                                                  |
| `friend {event, username}`                                                                         | `request_received`, `request_accepted`, `friend_removed` (from the HTTP friend routes)                                                                             |
| `notice {code, usernames?, deadline?}`                                                             | `dropped-at-loading`, `player-disconnected`, `player-reconnected`, `player-left`, `player-removed`, `owner-changed`, `kicked`, `game-cancelled`, `server-draining` |
| `game.loading {game, deadline}`                                                                    | a game is loading: load what it needs, then send `game.loaded`                                                                                                     |
| `game.start {game, resumed}`                                                                       | the game runs (or you resumed it); a full snapshot follows straight away                                                                                           |
| `game.results {results}`                                                                           | the run is over and recorded                                                                                                                                       |
| `server.lag {late, skipped, worstMs}`                                                              | the game loop fell behind (in a running game, at most 1/s; see [Server lag](#server-lag))                                                                          |
| binary frame                                                                                       | a snapshot                                                                                                                                                         |

`RoomView` is `{id, phase, ownerId, members, invited, maxMembers: 4, blockers, loadingDeadline}`.
Each member is `{userId, username, status, connected, inGame, loaded, partner}`; `partner` is
`{dex, shiny, prestige?}` (`prestige`: its stars, absent at 0) or null. `blockers`
lists who keeps the owner from starting.

`game` (`GameStatic`) holds what doesn't change during a run, and is sent once at start and
again on resume: `roomId`, `gameId`, `seed` (the world), `tickHz`, `snapshotHz`,
`choiceTimeoutS`, `roster` (the sim's `RosterState`: this run's wild Pokémon and bosses, for
preloading sprites), and `players` (`{id, username, index, dex, shiny, prestige?}` per player, in
join order; `prestige` is the Pokémon's stars, absent at 0).

## Server lag

The server runs every game on one 30 Hz loop. When that loop runs a tick more than a tick late
(a GC pause, a blocked event loop, a slow tick) it catches up; when it is still behind after
five catch-up ticks it skips ahead. Players in running games then get
`server.lag {late, skipped, worstMs}`: how many times each happened since the last one, and the
most the loop was behind (ms). It is sent at most once a second, only when something happened,
and is for diagnostics only (the in-game network stats show "Server: struggling"). It was added
within protocol 7: older clients ignore unknown message types.

## Friend activity

Presence carries what an online friend is doing (`activity`, absent when offline; added in
protocol 7 without a version bump, so older clients just ignore it):

- `{kind: "menu"}`: anywhere outside a run. In a room's lobby the status is `in_lobby` and the
  client says "In a room" rather than "Main Menu" (it matters to whoever wants to invite them).
- `{kind: "solo" | "coop", dex, shiny, elapsedS, paused?, prestige?}`: in a run, with their Pokémon (and its stars) and the
  run time in seconds when the message was sent. The client ticks the clock on locally unless
  `paused` (paused, a pending choice, loading, or a coop game with nobody connected). Status is
  `in_game` for both.

The server never sends it every second: it re-checks runs every heartbeat and sends a
`presence.update` only when the kind, the Pokémon or the pause changes, or when the friend's
local clock would be off by more than 2 s (`MAX_CLOCK_DRIFT_S` in `apps/server/src/game/activity.ts`).

Coop activity comes from the server's own game. Solo runs are simulated by the client, which
reports their clock with `activity {solo}`: as the run starts, when it pauses (after 2 s, so a
card pick doesn't flicker) or resumes, at each checkpoint, again after a reconnect, and `solo:
null` when it's over. The server only accepts a `runId` that is the player's own open solo run,
takes the Pokémon from that run, and caps the clock at the wall-clock time since its start. The
activity falls back to the menus when the run is reported (`POST /api/runs`), credited by the
timeout sweep, unreported for 5 minutes (the client reports at least every 3 minutes with its
keep-alive checkpoints), or when the session ends.

## Rooms

```
lobby ──room.start (owner; everyone ready)──▶ loading ──everyone loaded, or the timeout──▶ running
  ▲                                              │ nobody loaded: game-cancelled             │
  └────────── results sent ◀── ended ◀───────────┴─────────── the run ends ◀─────────────────┘
```

- **Members** (up to 4) join by accepting an invite. You can only invite friends who are online.
  If the owner leaves, the owner role passes to the next member who is still connected.
- **Ready check.** The owner can start only when every member is `ready`, connected, and has a
  partner. Clients set `busy` while in the gacha, shop, collection or settings, so a member in the gacha
  blocks the start and everyone sees who it is. This fixes the legacy bug where the game
  started without them and still showed them as playing.
- **Partners.** The lobby shows each member's partner from their save. It's read when they join
  and when they get ready, and when they change it (`PUT /api/save/partner`) while the room is in
  the lobby (or prestige it); a change during a game shows after it.
- **Loadouts** come from each member's server save, never from the client: their partner (dex,
  shiny if owned), its upgrades and prestige stars, move bindings and bans, and the legendaries
  they've beaten.
- **Loading** waits for `game.loaded` from every member until `LOADING_TIMEOUT_S` (15 s). Members
  who haven't loaded by then are dropped from the game, but stay in the room with `inGame: false`
  and status `not-ready`. Everyone gets `notice dropped-at-loading`, and the run starts with the
  rest. The sim is rebuilt with the same seed, so the world and roster are the same.
- **Ended.** The run is recorded, everyone in it gets `game.results`, and the room returns to the
  lobby with every member `not-ready`.
- A member who disconnects in the lobby keeps their place for the reconnect grace (60 s). After
  that they're removed. A room with no members left is closed.

## The game

- **Loop.** One drift-corrected 30 Hz ticker steps every running game. Ticks are scheduled
  against absolute times; a late timer catches up at most 5 ticks and otherwise skips ahead and
  logs a warning. While nobody in a game is connected, its sim is frozen.
- **Inputs.** The server keeps the latest input of each player and applies it every tick. A
  `slot` press waits for the next tick. Input order is tracked **per player per game**: an input
  is ignored if its `gameId` isn't the running game, or if its `seq` isn't above the last one
  applied for that player in this game. That counter resets when the player reconnects. Each
  snapshot carries `ackSeq`, the last `seq` applied for you, which is the hook for client-side
  prediction and reconciliation. A client's `seq` counts from 1 in each game, and a socket
  outlives games, so the counter must never be per socket. In version 3 it was, and a player who
  had played a game had all their inputs dropped at the start of the next one, for as long as the
  previous game lasted.
- **Aiming.** Attacks auto-aim unless the input carries `aim`; then the sim aims every aimed
  attack that way (see "Aiming" in `packages/sim/README.md`). It rides in movement updates, so
  it adds no messages and the rate limit (sized for 30 inputs/s) still holds. One byte keeps it
  within ~0.7° of the client's angle; the client snaps its own aim indicator and facing to the
  same steps (`quantizeAim`). While `fire` is set too (the mouse button or a gamepad trigger is
  held), aimed moves fire on cooldown even with nothing in reach.
- **Intents** go to `sim.submitIntent` for the sender, and the reply carries the result. An intent
  whose `gameId` isn't the running game fails with `not_playing`; choice ids restart in every
  game, so a late intent can't hit the wrong choice.
- **Choices are state.** Level-up cards, item swaps and bonds are `pendingChoices` in the sim. The
  game pauses while any are pending, and **every** snapshot lists all of them: yours in full in
  `choices`, everyone's as `waiting` (`{id, playerId, kind, deadlineTick}`). A message that never
  arrives can't leave anyone stuck. A choice resolves to its first option after
  `CHOICE_TIMEOUT_S` (30 s), or at once if its player disconnects or leaves. Overlapping choices
  are separate entries. New choice kinds pass through unchanged.

## Snapshots

The server sends snapshots at `SNAPSHOT_HZ` (20/s; every 1–2 ticks) while playing, one per client, built by
`SnapshotEncoder` in `packages/netclient`. That module is shared, so the future solo adapter can
use the same projection.

**Interest management.** Enemies, projectiles, pickups, fields and hazards are sent within 950
units of your Pokémon (legacy's radius). They stay until 1100 units, so things at the edge don't
flicker in and out. Players, the team and pending choices are always sent.

**Spectating.** While you're down in coop, `game.spectate {gameId, target}` moves that area onto
a teammate (`SnapshotEncoder.focusId`), so the client can follow them with the camera. The server
only takes it from a player who is down, for a target in the same game who is connected and
hasn't left; anything else (yourself, `null`, an unknown id, a wrong `gameId`) centres it on you
again. It is cleared when you're revived (a teammate, or the rift's exit), when the target
disconnects or leaves (the client then picks the next player and asks again), and when you
reconnect. Only the area moves: players (your own Pokémon included, so prediction is
unaffected), `self`, `stats`, your choices and your personal events still come for you, and events
with a position are filtered around the target. A switch is sent on the next tick. The entities
around the new target enter through the usual delta rows, the old ones leave as ids: with
`pnpm --filter @pokesurvivor/netclient bandwidth 6` (4 players, ~66 enemies around the target),
the first frame after a switch is ~2.2 KB (a full frame is ~6.3 KB, a normal delta under 1 KB),
the frames after it are normal deltas, and switching back is ~0.3 KB.

**Frame layout.** Frames are binary and use zigzag varints throughout:

```
kind (1 = snapshot)
header: seq, tick, time (ms), ackSeq, flags (bit 0 full, bit 1 paused), baseSeq
7 delta tables: players, enemies, projectiles, pickups, fields, hazards, team
JSON part (string)
events (binary, by shape)
```

**Delta tables.** Each table is a set of rows of integers, keyed by id: the entity id, or the
player index. For each client, the encoder remembers what it last sent and writes:

- the ids that were removed;
- new rows in full;
- for changed rows, a bitmask of the changed fields plus the change in each.

Values are quantized: positions to ½ unit (players to ⅛), angles to 1/64 rad, HP to whole
points, flags as bit sets. Strings such as pickup kinds, move ids and types go through a string
table per connection: a new string is sent once in the JSON part, then referred to by index. A player's flags include `attacking` (casting,
until just after its next cast), so clients face it towards its aim (the sim's `facingOf`).
Enemies carry both the `shielded` flag and remaining `shield` HP. The client draws a blue shield
amount bar above the HP bar, on the same max-HP scale (a full 30% shield covers 30% of the bar).
Fields carry their timers as seen by a client: `arm` is the seconds left before a mine arms or a
meteor lands, and `progress` is 0–1 through the field's life, or for a meteor through its fall
(below 0 while a staggered one of a volley hasn't started).

**Reliability.** WebSockets are reliable and ordered, so the frame the server last sent is the
one the client has. No acks are needed for the deltas. Each delta names the frame it is based on
(`baseSeq`). If a client sees a gap or can't decode a frame, it sends `game.resync` and ignores
deltas until a full frame arrives. Full frames are sent at the start, on resume and on resync.
A client that can't keep up (more than 256 KB unsent) skips snapshots. The encoder keeps its
baseline, so the next delta is still correct, but the events in the skipped snapshots are lost
for that client.

**JSON part.** It holds:

- `choices` and `waiting`;
- `details`: a player's moves, slots, item, bonds, rerolls left, magnet, altar power and buff
  stacks (attack, speed, defense, regen), sent when they change;
- `self`, in every snapshot: the viewer's move cooldowns (0–1 of the full cooldown, per move, in
  1/50 steps) for the HUD, its speed before liquids (`moveSpeedOf`) for client-side
  prediction, and its Momentum stacks (kill streak, 1/10 steps; optional) for the HUD;
- `stats`, the viewer's only: its stats panel (sim `playerStats`), with attack, speed and max HP
  and their species base, and cooldown, damage reduction, regen, magnet, XP and crit. It's sent
  when it changes, at most every 15 ticks, and in every full frame; the client keeps the last;
- `world`: changes to every keyed record of `state.world` (`broken`, `propHp`, `altarsUsed`,
  `springs`, `chests`, and any the sim adds);
- `misc`: the rift on the map, the arena (geometry for `terrainRaw`), the weather, the run event
  and the lost Pokémon, with timers in whole seconds, sent when it changes;
- `shinies`, `ended`, new strings, and new event shapes.

**Events** are cosmetic. Each client gets the ones that concern it:

- events with an `x`/`y` within range;
- events naming an entity in its snapshot;
- personal events (`say`, `progress`, `slot`, `slot-locked`) only when they're its own;
- everything else.

Enemy healing uses `enemy-healed {id, x, y, amount}` on each successfully healed recipient,
so clients can draw a green pulse and restored-HP number. This uses the existing shape codec;
there are no new snapshot columns or changed input contracts. Clients ignore unknown cosmetic events.

The filter works on the events' shape, not on a list of types. Events are encoded by shape: the
first time a connection sees a type with a given set of keys, the shape goes in the JSON part;
after that, an event is its shape index plus one tagged value per key. Numbers are rounded to
0.1, and nested values fall back to JSON. Events that 2b or later phases add need no changes,
and neither do new keys on an event: a new key is a new shape, and clients ignore keys they don't
know (so they aren't breaking changes). For example, `enemy-hurt.moveType` (the damage number's
colour) added ~0.1 KB/s in the measurement below: a string-table index per hit.

**Bandwidth.** Measured with `pnpm --filter @pokesurvivor/netclient bandwidth` in a 4-player game
18 minutes in, with the bots kept together so every enemy is near every player (the worst case
for interest management). The numbers are per client.

| Encoding                       | 15 Hz     | 20 Hz         | Largest delta | Full frame |
| ------------------------------ | --------- | ------------- | ------------- | ---------- |
| **binary varints (chosen)**    | 10.0 KB/s | **12.5 KB/s** | 1.3 KB        | 10.0 KB    |
| binary + deflate (per message) | 7.9 KB/s  | 9.6 KB/s      |               |            |
| JSON arrays (same structure)   | 23.6 KB/s | 29.3 KB/s     | 3.1 KB        | 14.2 KB    |
| JSON arrays + deflate          | 9.0 KB/s  | 11.0 KB/s     |               |            |

At the 6-minute mark, before the event codec, events sent as JSON alone were ~14 KB/s;
`enemy-hurt` was 9.6 KB/s of that at 109 bytes each. Binary is well under the 30 KB/s target
without compression, so permessage-deflate stays off: it would add CPU per client for about
3 KB/s. A test asserts that a 4-player late game stays under 30 KB/s.

## Reconnects

- When a socket closes mid-run, the server calls `sim.setConnected(id, false)`. The player stands
  still, can't be hurt, and their pending choices resolve at once, so the others never wait.
  The others get `notice player-disconnected`.
- If they reconnect within `RECONNECT_GRACE_S` (60 s), for example after a network blip, a page
  reload or another device, the server sends `room`, then `game.start {resumed: true}` and a full
  snapshot, and play continues.
  Resume is keyed by the logged-in user, so there's no separate resume token. The others get
  `notice player-reconnected`.
- After the grace the player is removed: `sim.removePlayer`, then out of the room. They are
  credited with what they had when they were removed.
- If everyone is disconnected, the run is frozen. If nobody comes back within the grace, the run
  ends and is credited, and the room closes.
- During `loading`, a member who reconnects gets `game.loading` again and acks again
  (`NetRoomConnection` does this by itself if the assets are already loaded).

## Results

When the sim ends (everyone down, or everyone gone), the server calls `recordCoopRun` with each
player's `runSummaryFor`. A player's owned Pokémon decide rescue rewards. Players who left
mid-run are credited too, with their summary frozen when they left: their play time
(`leftAfterS`), the team's level and kills at that point, and their coins so far. That seemed
fairer than the end-of-run totals they weren't there for, or nothing. If recording fails, it is
retried after 1 s and 5 s, and then `game.results` has `credited: false`.

`game.results` is `{gameId, runId, credited, reason, players: [{userId, username, left, summary:
{run: RunSummary, player: PlayerSummary}, achievements?}]}`. `achievements` (absent if the run
wasn't recorded) lists the achievements the run unlocked for that player, `[{id, reward: {coins?,
tickets?, tickets10?}, title}]` as in `POST /api/runs`; their rewards were credited on top of the
run's own coins and tickets. It was added without a version bump: older clients ignore it.

## Deploys

On SIGTERM the server retains the existing drain: `notice server-draining {deadline}` stops
new room/game starts while running games continue on the old instance for `DRAIN_TIMEOUT_S`
(default 900 s). At the deadline, remaining games end with `server-shutdown` and are credited.
SIGINT in development uses a zero-second drain. Inputs, choices, leaves and normal disconnect
grace remain active during the drain.

Lobby/loading rooms are handed to the replacement: freeze new lobby mutations, wait for
in-flight requests, cancel loading, persist the latest lobby, then close those sockets with 1012.
A game that finishes during the drain first records results, then hands off its current lobby.
The already-running replacement adopts a persisted room on a member's connect or via heartbeat
polling. Shared reservations prevent duplicate codes/memberships; each payload is consumed once.

A reconnect to the replacement while a game is still on the old server receives
`notice room-handoff-pending`. Joining that code, creating another room or inviting a reserved
member fails with `room_pending`, explained in the UI. The game slot cannot transfer; ordinary
old-instance disconnect grace still applies. If that membership expires, the replacement sends
`notice room-handoff-expired`; otherwise its lobby is adopted when the game ends.

`RESTART_RECONNECT_GRACE_S` (180 s) controls unclaimed-handoff expiry and absent-member grace
after adoption. Expired rows are not restored. The existing login cookie identifies returning
members; there is no new token. Invites are transient. These notices are additive, with no
protocol bump (v7). A mismatch after deploy stops retries and offers Reload, including in-game.

Use one replica, `start-first` updates and stop grace exceeding the drain (16 min by default);
see [deploy.md](deploy.md). No sim snapshot/restore was added.

## Client library (`packages/netclient`)

- **`NetClient`**: the socket, hello and heartbeat, reconnect, the typed lobby API (`createRoom`,
  `invite`, `join`, `declineInvite`, `leaveRoom`, `kick`, `setStatus`, `start`), friends'
  presence, invites, and stats (`rttMs`, snapshots/s, bytes/s). Pass `createSocket` in Node, for
  example `ws` with a cookie header, as the bots do.
- **`RoomConnection`**: what the game screen talks to during a run. Use `loaded()`,
  `sendInput()` / `startInputLoop()` and `intent()`, and read `buffer` and `latest`. The
  prediction hooks are `ackedInputSeq`, `unackedInputs()` and `serverSelf`.
  `NetRoomConnection` implements it over the network. The phase 4 solo adapter (the sim in a Web
  Worker) implements the same interface, using `SnapshotEncoder`/`SnapshotDecoder` or the sim
  state directly.
- **`SnapshotBuffer`**: maps server ticks to local time from snapshot arrivals and renders
  `delayMs` (100 ms) behind. `sample(now)` returns the two snapshots around that time, and
  `interpolate()` lerps players, enemies and projectiles, but never across a jump: two samples
  further apart than `SNAP_SPEED` (1800 units/s) allows between them are drawn at the newer
  position (stragglers the sim sends back ahead of a player, rift arena trips, dashes). Entities
  new to a snapshot, or back in range, are drawn where they are. `test/jumps.ts` measures it.
- **`firstOption(choice)`**: the intent that picks a choice's first option.
- **`RoomConnection` extras** for the game client: a `loading` event (`{ game }`), `now()` (the
  clock snapshots were stamped with), and, solo only, `setPaused(paused)` and `quit()`. Client-side
  prediction (`apps/client/src/game/net/predict.ts`) uses `ackedInputSeq`, `unackedInputs()`,
  `serverSelf` and the snapshot's `self.speed`.

During choices, the sim still ticks at 30 Hz to enforce deadlines, but unchanged paused
snapshots are sent at 1 Hz. Entering/leaving a pause, successful intents, connection changes and
resync requests send a snapshot on the next tick. Leaving a choice pause resets the encoders,
so the immediate resume frame is full and discards sparse paused interpolation history. Snapshot `tick` continues advancing while
`time` and movement stay frozen, so choice countdowns continue updating once per second.

Local prediction replays held movement on the server tick grid, using input send timestamps
and the latest acknowledged movement to estimate its clock. An input sequence acknowledges
which movement was held; it does **not** count simulated movement steps. Several input packets
can be coalesced into one tick, or one input can persist across many ticks. Reconciliation
compares predictions at the same simulation tick, then eases the correction. This also lets
unchanged inputs use keepalives rather than one packet per movement step. No wire fields or
protocol version change is needed.

## Testing

`apps/server/src/game/*.test.ts` run headless bots (`src/test/bots.ts`) against a real server on
a random port. They use real WebSockets with injected latency and jitter (delivery stays in
order), forced drops and offline periods. Scenarios:

- sessions: anonymous, version mismatch, supersede, malformed and oversized messages, floods;
- presence and friend pushes;
- invites: friends and online only, accept and decline;
- the 4-member limit and owner transfer;
- a member set to `busy` blocks the start;
- lobby grace;
- inputs and acks;
- level-up with one of 4 disconnected (no stall);
- level-up with picks at 0 / 0.3 / 0.9 / 1.6 s;
- reconnect mid-choice and mid-run;
- the owner leaving mid-run;
- the run ending and crediting everyone, including a player who left;
- grace expiry, and everyone gone;
- an unresponsive loader dropped at loading, and a game cancelled when nobody loads;
- the existing drain (deadline and early finish), plus two-instance lobby/run-end handoff;
- snapshotting in-flight membership changes and rejecting lobby mutations after SIGTERM;
- pending members, duplicate reservations, loading cancellation and expiry without resurrection.
