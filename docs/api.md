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

| Status | Codes                                                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request` (body/query validation, incl. unknown dex/item/move/type ids; has `issues`), `unknown_upgrade`, `unknown_title`, `not_a_starter`, `invalid_answers`, `invalid_move`, `duplicate_move`, `unknown_banner`, `invalid_pull_count`, `invalid_payment`, `cannot_friend_self`, `duplicate_favourite` |
| 401    | `unauthenticated`, `invalid_credentials`                                                                                                                                                                                                                                                                        |
| 404    | `run_not_found`, `user_not_found`, `request_not_found`, `friend_not_found`, `mission_not_found`                                                                                                                                                                                                                 |
| 409    | `username_taken`, `pokemon_not_owned`, `insufficient_funds`, `upgrade_maxed`, `title_locked`, `starter_already_chosen`, `too_many_bans`, `run_already_finished`, `mission_not_done`, `mission_already_claimed`, `mission_reroll_used`, `mission_reroll_unavailable`, `already_friends`, `request_already_sent`  |
| 429    | `rate_limited`                                                                                                                                                                                                                                                                                                  |

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
- Register and login are each rate-limited per IP (`AUTH_RATE_LIMIT_MAX` per minute, default 10).
- Sessions last 30 days and are extended to a full 30 days when used after their first day.

## Save

The server owns the save. Coins, tickets, the collection, pity and stats are never written by
the client; they change only through server logic (the starter, run results, upgrades, the gacha,
missions and achievements).

| Method & path              | Body                      | Notes                                                                                      |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/save`            | –                         | The save (below)                                                                           |
| `PUT /api/save/partner`    | `{ dex, shiny? }`         | Must own it (and its shiny if `shiny`)                                                     |
| `PATCH /api/save/profile`  | `{ favourites?, title? }` | `favourites`: up to 3 owned `{ dex, shiny }`. `title`: an unlocked achievement id, or null |
| `PATCH /api/save/settings` | any subset of `settings`  | Merged into the current settings                                                           |
| `POST /api/save/starter`   | `{ dex, answers? }`       | The first Pokémon (below). `{ achievements, save }`                                        |
| `PUT /api/save/moves/:dex` | `{ bindings?, bans? }`    | Move slots and bans for an owned Pokémon (below)                                           |
| `POST /api/save/upgrades`  | `{ dex, upgradeId }`      | Buys the next level for an owned Pokémon with coins                                        |
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

**Moves** (legacy `pbind`/`pban`). `bindings` is 4 slots, each a move id or null: that move
always goes in that slot. Allowed: the Pokémon's starting move and its move pool (normal moves
plus its types'), each once. `bans` lists moves that never show up in its level-up cards: up to
its `ban` upgrade level (max 3), not its starting move. Either can be sent alone; an empty list
clears it.

```jsonc
{
  "version": 2,
  "coins": 500,
  "tickets": { "x1": 0, "x10": 0 },
  "partner": { "dex": 25, "shiny": false }, // dex null until one is chosen
  "owned": { "25": { "at": 1760000000000, "from": "gacha" } }, // starter|gacha|wild|rescue|reward
  "shiny": {},
  "starter": null, // the starter's dex once chosen
  "personality": null, // { trait, scores } if the test was taken
  "upgrades": { "25": { "max-hp": 2 } }, // dex -> upgrade id -> level
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
   must be owned. Rate-limited per IP (`ACTION_RATE_LIMIT_MAX`).
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

Coop runs are not reported over HTTP: the game server records them from its own simulation with
`recordCoopRun()` in `apps/server/src/runs/service.ts`, with the same `RunSummary` per player
(uncapped), which counts towards missions and achievements the same way. A player who left
before the end is credited with what they had when they left (`leftAfterS` is their play time).
Results reach the players as a `game.results` message ([protocol.md](protocol.md)).

## Gacha

The gacha rolls on the server with `crypto` randomness; the client only animates the results.
The rules are `gacha.json`, ported from legacy `gacha.js` and rebalanced (a lower 5★ rate, soft
pity, hard pity at 90):

- One banner per generation, each with its own pity. Only Pokémon with sprites are in a banner.
- Rarity weights from `rates`: 45.9 / 30 / 17 / 6.5 / 0.6 % (legacy: 45 / … / 1.5).
- Each pull adds 1 to the banner's pity, and any 5★ resets it to 0. From the `softPity.from`-th
  pull (74th) the 5★ chance is the base rate plus `softPity.stepPerPull` (6 points) per pull: 6.6%
  on the 74th, 12.6% on the 75th, … The extra chance comes from the other rarities in
  proportion to their weights. The pull that reaches `hardPity` (90) is a 5★.
- That is one 5★ per about 62 pulls (1.6%) in single pulls, and per about 55 (1.8%) in ×10s,
  whose guarantee can also give a 5★.
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
state machine, snapshots and reconnects. `GET /api/info` returns `{ protocolVersion, tickHz }`.
