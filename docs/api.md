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

| Status | Codes                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request` (body/query validation; has `issues`), `unknown_upgrade`, `cannot_friend_self`, `duplicate_favourite`                                         |
| 401    | `unauthenticated`, `invalid_credentials`                                                                                                                        |
| 404    | `run_not_found`, `user_not_found`, `request_not_found`, `friend_not_found`                                                                                      |
| 409    | `username_taken`, `pokemon_not_owned`, `insufficient_funds`, `upgrade_maxed`, `title_locked`, `run_already_finished`, `already_friends`, `request_already_sent` |
| 429    | `rate_limited`                                                                                                                                                  |

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
the client; they change only through server logic (run results, upgrades, and later the gacha).

| Method & path              | Body                      | Notes                                                                                      |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/save`            | –                         | The save (below)                                                                           |
| `PUT /api/save/partner`    | `{ dex, shiny? }`         | Must own it (and its shiny if `shiny`)                                                     |
| `PATCH /api/save/profile`  | `{ favourites?, title? }` | `favourites`: up to 3 owned `{ dex, shiny }`. `title`: an unlocked achievement id, or null |
| `PATCH /api/save/settings` | any subset of `settings`  | Merged into the current settings                                                           |
| `POST /api/save/upgrades`  | `{ dex, upgradeId }`      | Buys the next level for an owned Pokémon with coins                                        |
| `GET /api/upgrades`        | –                         | `{ upgrades: { [id]: { maxLevel, baseCost, growth } } }`                                   |

Every mutating save endpoint returns the updated save. Upgrade level `n + 1` costs
`round(baseCost * growth^n / 10) * 10` coins.

```jsonc
{
  "version": 1,
  "coins": 500,
  "tickets": { "x1": 0, "x10": 0 },
  "partner": { "dex": 25, "shiny": false }, // dex null until one is chosen
  "owned": { "25": { "at": 1760000000000, "from": "gacha" } }, // starter|gacha|wild|rescue|reward
  "shiny": {},
  "starter": null,
  "upgrades": { "25": { "hp": 2 } }, // dex -> upgrade id -> level
  "pity": { "1": 12 }, // banner id -> pulls since the last 5★
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
  "achievements": { "first_run": 1760000000000 }, // id -> unlocked at
  "legendsBeaten": {},
  "arenasWon": {},
  "itemsFound": {},
  "movesEvolved": {},
  "missions": {
    "daily": { "period": null, "missions": [] }, // [{ id, progress, claimed }]
    "weekly": { "period": null, "missions": [] },
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
     "shiniesCaught": [133]
   }
   ```

   `coins` is the run's total coin reward as the game computes it at the end of a run.
   The response is `{ runId, stats, capped, save }`, where `stats` is what was credited.

The server clamps the duration to the wall-clock time since `start` (and 3 hours), and every
other number to a flat allowance plus a per-minute rate of that duration (see
`apps/server/src/economy/config.ts`). It stores the original claim on the run when anything
was capped, credits coins and tickets through the ledger, adds caught shinies (and their
normal form) to the collection, and updates the stats. Each run can be reported once.

Coop runs are not reported over HTTP: the game server records them from its own simulation with
`recordCoopRun()` in `apps/server/src/runs/service.ts`.

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
`presence` (`offline` | `online` | `in_lobby` | `in_game`), and requests have `sentAt`. Until the
WebSocket server provides presence (phase 3b), everyone is `offline`.
