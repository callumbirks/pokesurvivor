# Balance records and the run export

To see what made an easy run easy and a hard run hard, every run keeps a **balance record** per
player: the setup, every card taken, a sample of the player's stats at the end of every minute,
what downed them, and the rifts. Records are analytics only: nothing in the game or the economy
reads them, and they never change how a run is credited.

## Where they come from

- The sim collects them (`packages/sim/src/balance.ts`) in each player's state
  (`PlayerState.balance`): deterministic, cheap (a few additions per tick and one sample per
  minute of run time), and carried through saves and restores (solo local saves, co-op
  `game_saves`). A game saved before records existed starts one at the restore (`setup.from`).
- They travel as the optional `balance` field of the player's `RunSummary`
  (`packages/protocol/src/balance.ts`, `BalanceRecord`).
- **Co-op:** the server's sim produces them; `recordCoopRun` stores them (`source: "server"`).
- **Solo:** the browser sends them with its checkpoints and final report (`POST /api/runs`,
  [api.md](api.md#runs)). Untrusted: the server checks shape and size, drops a bad one (the run
  is still credited) and flags implausible values. Each checkpoint replaces the stored record, so
  a run credited by the timeout sweep keeps the last one (`source: "client"`).

They are stored in `run_balance` (one row per run and player, `record` jsonb, `flags` text[]),
kept indefinitely, and deleted only with their run.

## The record

All times are run seconds (they stop while a choice is pending). Numbers keep 3 decimals.

- `setup`: `dex`, `shiny`, `prestige` stars, permanent `upgrades` (levels above 0), `players` in
  the run, `startMoves`, and `from` (0, or the restore time of an old save).
- `end`: time `t`, `reason` (`all-down`, `everyone-left`, or null while the run is going or
  when the server shut down), `left` (left early), team `level` and `kills`, the player's
  `lastHits`, `damageDealt`, `damageTaken`, `downs`, `revivesGiven`, held `item`, `rerolls`.
- `moves`: final moves with `level`, `evolved`, `learnedAt` (0 for starting moves), `evolvedAt`.
- `items`: held items in the order equipped (`t`, `id`).
- `picks`: every level-up card taken: `t`, the level `lv`, `card` (`new:…`, `upgrade:…`,
  `evolution:…`, `stat:…`), stat cards' `rarity` and `value` (the effect at that rarity),
  `auto` if picked by the deadline, and the `declined` cards of the offer (stat cards as
  `stat:attack@rare`).
- `timeline`: one sample at the end of each minute (`t` = 60, 120, …), plus one for the last
  seconds of the run:
  - `lv`, `hp`, `maxHp`;
  - `atk`: the whole attack multiplier over the species' base, and its factors `atkCard` (Power
    cards), `atkUpgrade`, `atkItem`, `atkPrestige`, `atkOther` (altar powers), `atkBuff` (move
    buffs) and `atkMomentum`;
  - `cd` (cooldown multiplier), `def` (defence in effect, damage ÷ (1 + def)), `regen` (HP/s),
    `spd` (speed multiplier), `crit`;
  - `kills` (team, so far), `lastHits` (player, so far), `dealt` and `taken` (this minute);
  - `mom` (Momentum stacks) and `momAvg` (their average over the minute);
  - `enemies` alive, `downs` and `revives` (given) this minute, and `down` / `rift` when the
    player was down / in a rift arena at the sample.
- `downs`: each time the player went down: `t`, `by` (what hit them: `kind` `contact`, `shot`,
  `zone`, `beam`, `liquid`, `trap` or `weather`, and for enemies their `dex` and `tier`: `wild`,
  `elite`, `boss` or `legend`), `taken10s` (damage in the ~10 s before), `rift`, and `revivedAt`
  (null: they stayed down; the last down of a run that ended `all-down` is the death).
- `rifts`: `t`, the legendary's `dex`, the arena `type`, `result` (`won`, `lost`, or null if the
  run ended in it) and `dur` (seconds in the fight).

About 8 KB of JSON per player for a 10-minute run and 25 KB for 30 minutes (most of it the
picks and the timeline); Postgres compresses it on disk.

## Implausibility flags

Solo records are what the browser says. The server keeps them but flags what can't be right
(`balanceFlags` in `apps/server/src/runs/balance.ts`), so the export can leave them out:

| flag                   | meaning                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `claim-capped`         | the server capped the run's claimed rewards                                         |
| `setup-dex`            | the record's Pokémon isn't the one the run was started with                         |
| `setup-above-save`     | prestige or an upgrade level above what the save has                                |
| `end-vs-summary`       | level, kills or duration differ from the run summary's                              |
| `timeline-vs-duration` | samples out of order, past the end, or not one per minute                           |
| `picks-above-levels`   | more cards taken than level-ups                                                     |
| `atk-card-above-cap`   | the Power multiplier above its ceiling                                              |
| `atk-card-vs-picks`    | the Power multiplier above what the Power picks taken could build at the top rarity |
| `defense-above-max`    | defence above `tuning.defense.max`                                                  |
| `crit-above-max`       | crit chance above 100%                                                              |

The checks use the game data the server runs with.
