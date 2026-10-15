# HTTP API

All endpoints take and return JSON. Authentication uses the `ps_session` cookie (httpOnly,
SameSite=Lax, Secure in production), set by register and login. Browsers send it on same-origin
requests and on the WebSocket upgrade, so the client handles no tokens.

## Errors

Every error has the same shape. `code` is stable and maps to a UI string in `en.json`;
`message` is for developers only.

```json
{ "error": { "code": "username_taken", "message": "Username is taken" } }
```

Every response with a status of 400 or more, API or not, has `Cache-Control: no-store`
([deploy.md](deploy.md#caching-behind-cloudflare)).

| Status | Codes                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request` (body/query validation, incl. unknown dex/item/move/type ids; has `issues`), `unknown_upgrade`, `unknown_title`, `not_a_starter`, `invalid_answers`, `invalid_move`, `duplicate_move`, `unknown_banner`, `invalid_pull_count`, `invalid_payment`, `cannot_friend_self`, `duplicate_favourite`, `username_not_allowed`                                                      |
| 401    | `unauthenticated`, `invalid_credentials`                                                                                                                                                                                                                                                                                                                                                     |
| 404    | `run_not_found`, `user_not_found`, `request_not_found`, `friend_not_found`, `mission_not_found`                                                                                                                                                                                                                                                                                              |
| 409    | `username_taken`, `pokemon_not_owned`, `insufficient_funds`, `upgrade_maxed`, `title_locked`, `starter_already_chosen`, `too_many_bans`, `prestige_not_ready`, `prestige_maxed`, `run_already_finished`, `run_credited_by_timeout`, `in_room`, `mission_not_done`, `mission_already_claimed`, `mission_reroll_used`, `mission_reroll_unavailable`, `already_friends`, `request_already_sent` |
| 429    | `rate_limited`                                                                                                                                                                                                                                                                                                                                                                               |

Dex numbers, held items, moves, types, upgrade ids, titles, banners and missions are all checked
against `@pokesurvivor/data`.

## Auth

| Method & path             | Body                     | Response                             |
| ------------------------- | ------------------------ | ------------------------------------ |
| `POST /api/auth/register` | `{ username, password }` | `201 { user: { id, username } }`     |
| `POST /api/auth/login`    | `{ username, password }` | `200 { user: { id, username } }`     |
| `POST /api/auth/logout`   | –                        | `204`, deletes the session           |
| `GET /api/auth/me`        | –                        | `{ user: { id, username } }`, or 401 |

- Usernames: 3–16 characters of `[A-Za-z0-9_]`, unique ignoring case, and also the public
  nickname. Login matches them ignoring case. Passwords: 8–128 characters, hashed with argon2id.
- Register rejects offensive usernames with 400 `username_not_allowed` (the body doesn't say which
  word matched). The check (`apps/server/src/auth/profanity.ts`) uses `obscenity`'s English list
  after folding case, resolving leetspeak (`0`→o, `1`→i/l, `3`→e, `4`→a, `5`→s, `7`→t, …),
  removing separators (`f_u_c_k`) and collapsing repeats (`fuuuck`); a whitelist keeps names like
  Scunthorpe, Dickson and Sharpedo. Register is the only endpoint that sets a username.
- Register and login are each rate-limited per IP (`AUTH_RATE_LIMIT_MAX` per minute, default 10).
- Sessions last 30 days and are extended to a full 30 days when used after their first day.

## Save

The server owns the save. Coins, tickets, the collection, pity and stats are never written by
the client; they change only through server logic (the starter, run results, upgrades, the gacha,
missions and achievements).

| Method & path              | Body                      | Notes                                                                                      |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/save`            | –                         | The save (below)                                                                           |
| `PUT /api/save/partner`    | `{ dex, shiny? }`         | Must own it (and its shiny if `shiny`); a room in its lobby shows it to the members        |
| `PATCH /api/save/profile`  | `{ favourites?, title? }` | `favourites`: up to 3 owned `{ dex, shiny }`. `title`: an unlocked achievement id, or null |
| `PATCH /api/save/settings` | any subset of `settings`  | Merged into the current settings                                                           |
| `POST /api/save/starter`   | `{ dex, answers? }`       | The first Pokémon (below). `{ achievements, save }`                                        |
| `PUT /api/save/moves/:dex` | `{ bindings?, bans? }`    | Move slots and bans for an owned Pokémon (below)                                           |
| `POST /api/save/upgrades`  | `{ dex, upgradeId }`      | Buys the next level for an owned Pokémon with coins                                        |
| `POST /api/save/prestige`  | `{ dex }`                 | Prestiges an owned Pokémon whose upgrades are all maxed (below)                            |
| `GET /api/upgrades`        | –                         | `{ upgrades: { [id]: { maxLevel, baseCost, growth } } }`                                   |

Every mutating save endpoint returns the updated save (the starter wraps it in `{ save }`).
Upgrades are the ones in `upgrades.json` (ids `max-hp`, `attack`, `speed`, `cooldown`, `defense`,
`regen`, `magnet`, `experience`, `coins`, `extra-move`, `crit`, `reroll`, `ban`); level `n + 1`
costs `round(baseCost * growth^n / 10) * 10` coins, as in legacy. A title must be the id of an
unlocked achievement that has a title.

**Starter.** A new save owns nothing, so the client first shows the personality test from
`starters.json` (helpers: `personalityScores`, `topTrait`, `bestStarters` in `@pokesurvivor/data`)
and suggests a starter; as in legacy, the player can accept it or pick any other starter.
`POST /api/save/starter` takes the chosen `dex` (must be in `starters.json`) and, if the test
was taken, `answers` (the index of the answer chosen for each question). It grants the
Pokémon (`from: "starter"`), makes it the partner, stores `starter` and `personality`
(`{ trait, scores }`, computed by the server from `answers`), and unlocks the `own-1`
achievement (100 coins). It works only while the save owns no Pokémon (else
`starter_already_chosen`). Legacy gives no other starting grant: new saves get 500 coins and no
tickets.

**Moves** (original `pbind`/`pban`). `bindings` is 4 slots, each a move id or null: that move
always goes in that slot. Allowed: the Pokémon's starting move and its move pool (normal moves
plus its types'), each once. `bans` lists moves that never show up in its level-up cards: up to
its `ban` upgrade level (max 3), not its starting move. Either can be sent alone; an empty list
clears it.

**Prestige.** Once every upgrade of an owned Pokémon is at its max level, `POST
/api/save/prestige` gives it a star (`prestige[dex]`, up to `tuning.json` `prestige.maxStars`, 3)
and resets **all** its upgrades, Repertoire and Ban included, and its banned moves. It is free.
Move slot bindings stay: every move they can name (the starting move and the move pool) is
allowed without any upgrade. Refused with `409 prestige_not_ready` while an upgrade has a level
left to buy, and `409 prestige_maxed` at the max stars (checked first); both change nothing. The
save is locked for the check and the reset, so two requests at once prestige once. Each prestige
is stored in `pokemon_prestiges` (the stars reached and the levels and bans it reset) and written
to the ledger as a zero-coin entry (`reason: "prestige"`, `refId: "dex:prestige:stars"`): the
coins spent on a Pokémon since its last prestige are its `upgrade_purchase` entries (`refId`
`dex:…`) after that entry.

Each star adds `tuning.json` `prestige.perStar.*` (5% each) to its stats in every run, solo and
co-op: max HP, damage and speed × `1 + perStar × stars`, move cooldowns × `1 − perStar × stars`,
and damage reduction and crit chance + `perStar × stars` points, as their upgrades add up. Enemies
don't scale with it. Co-op loadouts read the stars from the save; solo runs are simulated by the
client from the save it fetched (like upgrades), and their reports are capped the same way
whatever the stars. Stars are also in the room's member `partner`, the game's `players`, friends'
`partner` and run activity (`prestige`, absent at 0; see [protocol.md](protocol.md)).

```jsonc
{
  "version": 3,
  "coins": 500,
  "tickets": { "x1": 0, "x10": 0 },
  "partner": { "dex": 25, "shiny": false }, // dex null until one is chosen
  "owned": { "25": { "at": 1760000000000, "from": "gacha" } }, // starter|gacha|wild|rescue|reward
  "shiny": {},
  "starter": null, // the starter's dex once chosen
  "personality": null, // { trait, scores } if the test was taken
  "upgrades": { "25": { "max-hp": 2 } }, // dex -> upgrade id -> level
  "prestige": { "25": 1 }, // dex -> prestige stars (absent: none)
  "moveBindings": { "25": ["thunder-shock", null, "tackle", null] },
  "moveBans": { "25": ["growl"] },
  "pity": { "kanto": 12 }, // banner id -> pulls since the last 5★
  "stats": {
    "runs": 0,
    "groupRuns": 0,
    "bestTimeS": 0,
    "bestGroupTimeS": 0,
    "bestLevel": 0,
    "totalKills": 0,
    "bossesTotal": 0,
    "coinsEarned": 0,
    "shinies": 0,
    "pulls": 0,
    "riftWins": 0,
    "evolutions": 0,
    "missionsDone": 0,
  },
  "achievements": { "own-1": 1760000000000 }, // id -> unlocked at
  "legendsBeaten": { "150": 1760000000000 }, // dex -> first beaten in a rift
  "arenasWon": { "fire": 1760000000000 }, // rift arena type -> first won
  "itemsFound": { "leftovers": 1760000000000 },
  "movesEvolved": { "tackle": 1760000000000 }, // base move id -> first evolved
  "missions": {
    // As of the last time they were rolled; GET /api/missions brings them up to date.
    "daily": { "period": "2026-10-13", "rerolled": false, "missions": [] },
    "weekly": { "period": "2026-W42", "rerolled": false, "missions": [] },
  },
  "profile": { "favourites": [{ "dex": 25, "shiny": false }], "title": null },
  "settings": {
    "quality": "auto",
    "damageNumbers": true,
    "calmMode": false,
    "showFps": false,
    "stickScale": 1,
    "musicVolume": 0.55,
    "sfxVolume": 0.7,
    "muted": false,
  },
  "updatedAt": "2026-10-13T10:00:00.000Z",
}
```

## Runs

Solo runs are simulated in the browser, so their results are claims the server caps:

1. `POST /api/runs/start` `{ pokemon: { dex, shiny } }` → `201 { runId, startedAt }`. The Pokémon
   must be owned. A player in a room (party) can't start one: `409 in_room` until they leave it.
   Rate-limited per IP (`ACTION_RATE_LIMIT_MAX`).
2. `POST /api/runs` with the summary when the run ends:

   ```json
   {
     "runId": "…",
     "durationS": 754,
     "level": 31,
     "kills": 1210,
     "bosses": 3,
     "coins": 640,
     "ticketsX1": 2,
     "ticketsX10": 0,
     "shiniesCaught": [133],
     "progress": {
       "defeatsByType": { "water": 310, "flying": 95 },
       "chestsOpened": 1,
       "itemsEquipped": ["leftovers"],
       "movesEvolved": ["thunder-shock"],
       "riftWins": ["fire"],
       "legendariesDefeated": [146],
       "rescued": [16]
     }
   }
   ```

   This is `RunSummary` from `@pokesurvivor/protocol`. `coins` is the run's total coin reward as
   the game computes it at the end of a run. `progress` (`RunProgress`) holds the counters
   missions and achievements need; it may be left out (counts as empty):
   - `defeatsByType`: defeats per type id; an enemy counts once for each of its types.
   - `itemsEquipped`: each time a different held item was equipped; `movesEvolved`: the base
     move id each time a move evolved; `riftWins`: the arena type of each rift battle won;
     `legendariesDefeated`: rift legendaries beaten.
   - `rescued`: lost Pokémon brought home whose 20% "joins you" roll succeeded. They join the
     collection (`from: "rescue"`) if not owned; the 150-coin consolation is part of `coins`.

   The response is `{ runId, stats, capped, achievements, save }`, where `stats` is what was
   credited and `achievements` the ones it unlocked (`[{ id, reward, title }]`).

The server clamps the duration to the wall-clock time since `start` (and 3 hours), and every
other number to a flat allowance plus a per-minute rate of that duration (see
`apps/server/src/economy/config.ts`): defeats per type to the capped kills, chests, items,
evolutions, rift wins and rescues per minute, legendaries to the rift wins. It also drops
entries that can't happen: shinies without shiny sprites, non-legendary "legendaries", and
rescues that legacy can't spawn (over 3★, legendary, hovering or without sprites). It stores
the original claim on the run when anything was capped, credits coins and tickets through the
ledger, adds caught shinies (and their normal form) and rescued Pokémon to the collection,
updates the stats, items found, moves evolved, arenas won and legendaries beaten, advances the
missions and unlocks achievements. Each run can be reported once.

### Checkpoints and the timeout credit

A closed tab, a crash or a dead battery would otherwise lose a whole run, so the client also
sends the run so far while it plays:

3. `POST /api/runs/checkpoint` with the same body as `POST /api/runs` (the `RunSummary` so far
   and the `runId`) → `200 { runId, stats, capped }`, where `stats` is the checkpoint as stored.
   It is validated and capped exactly like a final report for the time since `start`, and
   replaces the run's previous checkpoint. **Nothing is credited.** Rate-limited per IP
   (`ACTION_RATE_LIMIT_MAX`). The client sends one about every minute of run time, at least
   every 3 minutes of wall-clock time while the run is open (paused, or waiting on a choice), and
   when the page is hidden or closed (`fetch` with `keepalive`; a hidden solo run also pauses).
   Locally it saves the run more often (as it starts and every 5 s of run time), so a reload at
   any point can resume it, even before the first checkpoint reached the server.
4. **Timeout credit.** If a run that has a checkpoint gets neither a checkpoint nor a final
   report for `RUN_CHECKPOINT_TIMEOUT_S` (default 3600 s), the server credits that last
   checkpoint as the run's result, exactly as a final report with those numbers would be, and
   closes the run (`runs.timed_out`; it ends at the checkpoint's time, for leaderboards and
   missions). Runs without a checkpoint stay open. The server looks for such runs at start and
   every `RUN_SWEEP_INTERVAL_S` (60 s); the state is all in Postgres, so it survives restarts,
   and several instances can sweep at once.

**A run is credited at most once.** Whichever comes first, the final report or the timeout
credit, credits the run and closes it (both lock the run row). After that:

- another final report is refused with `409 run_already_finished`, or `409
run_credited_by_timeout` if the timeout credited it. The latter's error body also has
  `credited`: the `RunSummary` that was credited (`{ "error": { "code", "message", "credited" } }`);
- a checkpoint is refused the same way. Resuming a saved run starts with a checkpoint, so a run
  that was credited by timeout can't be resumed: the client drops its local save and says the
  run was already credited from its last checkpoint. A tab that comes back to a run credited
  while it was away (a phone that switched apps for longer than the timeout) gets the same 409
  on its next checkpoint: the client ends the run there and shows what was credited. (The alternative, crediting a later report
  only for its difference above the checkpoint, was rejected: missions and achievements count
  whole runs, so they can't be applied as differences.)

Coop runs are not reported over HTTP: the game server records them from its own simulation with
`recordCoopRun()` in `apps/server/src/runs/service.ts`, with the same `RunSummary` per player
(uncapped), which counts towards missions and achievements the same way. A player who left
before the end is credited with what they had when they left (`leftAfterS` is their play time).
Results reach the players as a `game.results` message ([protocol.md](protocol.md)).

## Gacha

The gacha rolls on the server with `crypto` randomness; the client only animates the results.
The rules come from [`packages/data/json/gacha.json`](../packages/data/json/gacha.json) and are
returned by `GET /api/gacha`; clients render its rates, pity thresholds and guarantee rather
than keeping separate balance constants.

- One banner per generation, each with its own pity. Only Pokémon with sprites are in a banner.
- Rarity probabilities are each `rates` weight divided by the total weight.
- Each pull adds 1 to the banner's saved pity, and any 5★ resets it to 0. From the
  `softPity.from`-th pull the 5★ chance is its base rate plus `softPity.stepPerPull` for each
  pull since that threshold, including the threshold pull. The extra chance comes from the
  other rarities in proportion to their weights. The pull that reaches `hardPity` is a 5★.
- Changing the configuration preserves saved counters: the next pull uses the counter plus
  one against the current thresholds. A counter below the new soft-pity threshold gets the
  base chance; a counter already at or above hard pity guarantees a 5★ on its next pull.
- Effective 5★ frequency depends on pity and the ×10 guarantee, not only the base rate.
  Use the [manual projection model](../tools/gacha/README.md) to compare configurations.
- The last pull of a ×10 is at least `multiGuaranteeMinRarity` (4★) if none of the others was.
  It rolls at that pull's soft-pity rates, restricted to those rarities.
- A rarity with no Pokémon in the banner falls back to the nearest one (−1, +1, −2, …).
- `shinyRate` (1%) of pulls of Pokémon with shiny sprites are shiny. Shinies don't repeat: an
  owned shiny becomes a missing shiny of the same rarity, or the normal form if none is missing.
  A shiny also grants the normal form.
- Duplicates refund coins by rarity (`duplicateRefund`; legacy never gives a duplicate shiny, but
  one would pay ×`shinyDuplicateMultiplier`).

| Method & path          | Body                          | Response                                                    |
| ---------------------- | ----------------------------- | ----------------------------------------------------------- |
| `GET /api/gacha`       | –                             | Rules and banners (below); `pity` per banner when logged in |
| `POST /api/gacha/pull` | `{ banner, count, payWith? }` | `{ pullId, banner, results, pity, achievements, save }`     |

`GET /api/gacha` returns `cost`, `rates`, `softPity` (`{ from, stepPerPull }`), `hardPity`, `multiGuaranteeMinRarity`, `shinyRate`,
`duplicateRefund`, `shinyDuplicateMultiplier`, `rarities` and `banners`: each banner from
`gacha.json` plus `featured` (its three strongest 5★), `poolSize` (Pokémon per rarity) and
`pity` (null when logged out).

`POST /api/gacha/pull`: `banner` is a banner id (`kanto` … `paldea`), `count` is 1 or 10, and
`payWith` is `tickets` (default; 1 or 10 ×1 tickets) or `tickets10` (one ×10 ticket, ×10 pulls
only). Rate-limited per IP (`ACTION_RATE_LIMIT_MAX`). Each result is
`{ dex, rarity, shiny, isNew, refund }` in pull order; `pity` is the banner's pity afterwards.
The tickets spent (`gacha_pull`) and the refunds (`gacha_refund`) go through the ledger with the
pull id as `refId`, and every pull is stored in `gacha_pulls` (cost, pity before and after,
results) for auditing.

## Missions

Each player gets `dailyCount` (3) daily and `weeklyCount` (2) weekly missions from the templates in
`missions.json`, with a goal (and for some a Pokémon type) rolled per mission. They are rolled
deterministically from the user id and the period (the day, or the ISO week, in
`LEADERBOARD_TIME_ZONE`), so they are the same however often they're rolled. Run results advance
them (`event` in `missions.json`: `defeat` from `kills`, `bosses` and `defeatsByType`, `chest`,
`item`, `evolve`, `rift-win` from `progress`, `run-end` from the duration, level, coins and the
Pokémon played); claiming a daily advances "complete N daily missions". Progress stops at the
goal. Rewards are claimed by hand and paid through the ledger (`mission_reward`).

| Method & path                            | Response                                                    |
| ---------------------------------------- | ----------------------------------------------------------- |
| `GET /api/missions`                      | `{ daily, weekly }`, rolling the current period's if needed |
| `POST /api/missions/:kind/:index/claim`  | `{ missions, achievements, save }`                          |
| `POST /api/missions/daily/:index/reroll` | `{ daily, weekly }`                                         |

Each set is `{ period, rerolled, missions: [{ id, goal, param, progress, claimed }] }`; the text
is the template's `text` with `{count}` = `goal` and `{type}` = `param`'s name. `:kind` is
`daily` or `weekly`, `:index` the mission's position. A claim needs `progress >= goal`
(`mission_not_done`) and works once (`mission_already_claimed`). Reroll swaps one unclaimed daily
for a random different template, once per day (`mission_reroll_used`).

## Achievements

The achievements in `achievements.json` unlock on their own, from the save's stats and
collection, whenever those change (the starter, runs, gacha pulls, mission claims), as legacy's
`checkAch` did. Each pays its reward through the ledger (`achievement_reward`, `refId` = the
achievement id) and some unlock a profile title. They're in `save.achievements` (id → unlocked
at), and endpoints that can unlock them return the new ones as
`achievements: [{ id, reward, title }]` for the client's toasts.

## Leaderboard

`GET /api/leaderboard?mode=solo|group&period=daily|weekly|all&friends=true&pokemon=25&limit=50`

All parameters are optional (defaults: `solo`, `all`, not friends-only, every Pokémon, 50, max 100).
It ranks by best survival time: one entry per player (solo) or per exact team (group), and ties
share a rank. Days and ISO weeks start at midnight in `LEADERBOARD_TIME_ZONE` (default
`Europe/Madrid`). `friends=true` needs a login and keeps you and your friends (group: teams with at
least one of you). `pokemon` keeps runs where that Pokémon was played.

```json
{
  "mode": "solo",
  "period": "weekly",
  "entries": [
    {
      "rank": 1,
      "durationS": 1203,
      "endedAt": "2026-10-13T09:12:00.000Z",
      "players": [
        { "username": "Ash", "pokemon": { "dex": 25, "shiny": false }, "level": 41, "kills": 2300 }
      ]
    }
  ],
  "me": null
}
```

`me` is your best entry on that board, with its rank, even if it is outside `limit`.

## Friends

| Method & path                                  | Body           | Notes                                                                                      |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/friends`                             | –              | `{ friends, incoming, outgoing }`                                                          |
| `POST /api/friends/requests`                   | `{ username }` | `201 { status: "pending" }`, or `200 { status: "accepted" }` if they had already asked you |
| `POST /api/friends/requests/:username/accept`  | –              | `{ status: "accepted" }`                                                                   |
| `POST /api/friends/requests/:username/decline` | –              | `204`                                                                                      |
| `DELETE /api/friends/:username`                | –              | `204`; removes a friend or cancels a request you sent                                      |

Each list item has `{ username, partner, favourites, title }`. Friends also have `since` and
`presence` (`offline` | `online` | `in_lobby` | `in_game`), and requests have `sentAt`. Presence
comes from the WebSocket game server: `online` with a socket open, `in_lobby` in a room (or dropped
from its game), `in_game` playing. Changes are also pushed live over the socket
(`presence.update`), and so are friend requests accepted, received and removals (`friend`); see
[protocol.md](protocol.md).

## Game server

Rooms, invites and coop games run over the WebSocket at `/ws` (same origin, authenticated by the
session cookie), not over HTTP. [protocol.md](protocol.md) describes the messages, the room
state machine, snapshots and reconnects. `GET /api/info` returns `{ protocolVersion, tickHz }`,
plus `build` and `version` in a deployed server.

## Build

A deployed server knows its build: an opaque id written by the client build to
`apps/client/dist/build.json` and baked into that bundle (see [deploy.md](deploy.md#versions-and-the-reload-prompt)).
Every `/api/` response carries it in `X-Build` and its version label (`v10`) in `X-Build-Version`,
and `welcome` sends both over the WebSocket. A client with a different build id offers a reload.
Development servers have no build and send neither.
