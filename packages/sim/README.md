# @pokesurvivor/sim

The headless game simulation for 1–4 players. The server
runs it for co-op rooms; the browser runs it in a Web Worker for solo. No DOM, Canvas or Audio,
and deterministic: one seeded RNG in the state, a fixed 30 Hz tick, no wall clock (ESLint bans
`Math.random`, `Date.now`, `performance` and timers in `src/`).

Phase 2a ported the core loop; phase 2b added rifts and the legendary arena, bonds, events,
weather and interactables (see [Rifts, bonds, events, weather, interactables](#rifts-bonds-events-weather-interactables)).

```ts
import { createSim, drainTicks } from '@pokesurvivor/sim';

const sim = createSim({
  seed: 1234,
  players: [
    { id: 'u1', dex: 25, shiny: false, upgrades: { attack: 3, 'max-hp': 5 } },
    {
      id: 'u2',
      dex: 4,
      bannedMoves: ['harden'],
      moveBindings: ['ember', null],
      legendsBeaten: [150],
    },
  ],
  choiceTimeoutSeconds: 30, // null for solo: choices wait forever
});

sim.setInput('u1', { moveX: 1, moveY: 0 }); // persists; `slot: 2` switches move once, `aim: 0` aims right
sim.step(); // one tick (1/30 s)
for (const c of sim.state.pendingChoices) {
  if (c.kind === 'level-up')
    sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: c.options[0].id });
  if (c.kind === 'bond')
    sim.submitIntent(c.playerId, { type: 'pickBond', choiceId: c.id, moves: c.loose.slice(0, 2) });
}
const events = sim.drainEvents(); // cosmetic: sounds, numbers, VFX, banners
```

## API

| Call                                                                                              | What it does                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSim({ seed, players, choiceTimeoutSeconds?, debug? })`                                     | New run. `players[i]`: `id`, `dex`, `shiny?`, `upgrades?` (permanent upgrade levels by id, clamped to each max), `bannedMoves?`, `moveBindings?` (preferred slot per move), `legendsBeaten?` (dex numbers; unbeaten legendaries come up 4× as often in rifts). `debug`: `invulnerable`, `noSpawns` (also stops events and thieves; rifts still open). |
| `setInput(playerId, { moveX, moveY, slot?, aim?, fire? })`                                        | Movement (clamped to length 1) and `aim` persist until changed (every call sets both). `aim`: manual aim in radians (see [Aiming](#aiming)); absent or null is auto-aim. `fire`: fire held (manual aim only). `slot` is a one-shot request applied on the next running tick: send it once per key press.                                              |
| `submitIntent(playerId, intent)`                                                                  | `pickCard {choiceId, cardId}`, `pickItem {choiceId, itemId}` (the item to hold), `pickBond {choiceId, moves}` (loose move ids: two for `pair`, one for `add`), `reroll {choiceId}`, `cycleSlot {dir}`. Returns `{ ok }` or `{ ok: false, error }`; never throws on bad input (unknown types and malformed fields are rejected).                       |
| `step()`                                                                                          | One tick. While any choice is pending it only counts ticks toward the choices' deadlines (the game is paused for everyone).                                                                                                                                                                                                                           |
| `setConnected(playerId, bool)`                                                                    | Disconnected players stand still, don't attack, can't be hurt, aren't targeted or counted for difficulty/XP, and their pending choices resolve at once. The reconnect grace is the caller's.                                                                                                                                                          |
| `removePlayer(playerId)`                                                                          | Left for good (or grace ran out). Stays in `state.players` with `left: true` for the summary. The run ends when everyone has left.                                                                                                                                                                                                                    |
| `drainEvents()`                                                                                   | Events since the last call.                                                                                                                                                                                                                                                                                                                           |
| `state`, `paused`, `ended`                                                                        | Read the state directly (treat it as read-only).                                                                                                                                                                                                                                                                                                      |
| `summary(owns?)`, `runSummaryFor(playerId, owns?)`                                                | Per-player run results (see below). `owns` says whether a player already owns a Pokémon (rescues they own pay 150 coins instead).                                                                                                                                                                                                                     |
| `hash()`                                                                                          | Fingerprint of the state (cyrb53 of its JSON). Same seed + same calls → same hash.                                                                                                                                                                                                                                                                    |
| `restoreSim(state)`                                                                               | A sim from a snapshot (a deep copy of `state`, e.g. JSON). It continues exactly like the original.                                                                                                                                                                                                                                                    |
| `propsInRect`, `propHp`, `terrainRaw`, `liquidKind`                                               | World queries for renderers (terrain is a pure function of `world.seed` and `world.arena`: pass it to `terrainRaw`; props also of `world.broken`).                                                                                                                                                                                                    |
| `WorldView`                                                                                       | For clients: a read-only map over a world state they mirror from snapshots (`setArena`, `setRecords`, `setBiome`): `terrain`, `propsInRect` (broken props forgotten), `liquidKind`, and `move(body, x, y, speed)`, the sim's own movement step (`moveBody`: liquids, ice, walls, props), which client-side prediction uses.                           |
| `moveSpeedOf`, `playerMoveSpeed(state, p)`, `moveStatsAt(id, level, evolved)`, `hash2`            | A player's speed before liquids (sent to its own client for prediction), a move's levelled stats (to size cast visuals), the map hash (tiles).                                                                                                                                                                                                        |
| `debugOpenRift()`, `debugStartArena(type?)`, `debugStartEvent(id)`, `debugStartWeather(kind, s?)` | Debug view and tests: open a rift, go to an arena, start `horde`/`gold`/`lost`/`thief`, start a weather.                                                                                                                                                                                                                                              |

The run ends when every remaining player has been down for 1.3 s (solo) / 1.6 s (group), or when
everyone has left: `state.ended = { reason: 'all-down' | 'everyone-left', tick, time }`.

## State

`state` is plain JSON data: no classes, closures, Maps, Sets or `Infinity`. Caches derived from it
(world chunks, the enemy grid, path fields) live outside it and are rebuilt.

| Key                                                                                          | Contents                                                                                                                                                                                                                                                        | Changes                           |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `tick`, `time`                                                                               | Ticks stepped (paused ones too) and seconds played (running only).                                                                                                                                                                                              | every tick                        |
| `rng`                                                                                        | 4 × uint32 (sfc32).                                                                                                                                                                                                                                             | every tick                        |
| `players[]`                                                                                  | Position, velocity, aim and target, HP and stats, buffs, moves (`stats` already levelled), slots, item, input, revive progress, run stats.                                                                                                                      | every tick (position, timers)     |
| `enemies[]`                                                                                  | ~64 alive (cap) plus minions and bosses: position, HP, statuses, AI state (`phase`, boss `ai`, `jump`), `def` (base stats).                                                                                                                                     | every tick                        |
| `projectiles[]`                                                                              | Player and enemy shots, orbs (`orb: true`). Tens at a time. `hits` / `hitLog` are what they already hit.                                                                                                                                                        | every tick                        |
| `fields[]`, `hazards[]`                                                                      | Mines/meteors/turrets/trail pools; telegraphed enemy attacks. A handful.                                                                                                                                                                                        | every tick                        |
| `pickups[]`                                                                                  | XP gems, coins and loot on the ground: up to 420 (then the oldest gems merge). Mostly still unless pulled.                                                                                                                                                      | on drops/pulls                    |
| `team`                                                                                       | Shared level, XP, kills, bosses, coins, tickets, shinies.                                                                                                                                                                                                       | on events                         |
| `pendingChoices[]`                                                                           | `{ id, playerId, kind: 'level-up', level, options[] }`, `{ kind: 'item', held, found }` or `{ kind: 'bond', mode: 'pair' \| 'add', group, loose }`, each with `deadlineTick`.                                                                                   | on level-ups / item swaps / bonds |
| `world`                                                                                      | `seed`, `biome` (index, every 4 min), `broken` (tile keys of destroyed props), `propHp` (damaged props), `arena` (the carved arena's geometry while the team is in it), `altarsUsed`, `springs` (charge of springs not full), `chests` (locked-chest progress). | rarely; grows slowly              |
| `rift`                                                                                       | `checkT`, `misses`, `opened` (count), `open` (`{ x, y, ttl, t }` of the rift on the map).                                                                                                                                                                       | every tick from 75 s              |
| `arena`                                                                                      | null on the map. In the arena: geometry and type, legendary `dex`/`shiny`/`bossId`, centre `x`/`y`, `t`, `phase` (`fight`/`won`/`lost`), `endT`, `downT`, each player's `back` position and the map's enemies (`stash`).                                        | every tick in the arena           |
| `weather`                                                                                    | `current` (`{ kind, t, dur }` or null), `checkT`, `chipT`.                                                                                                                                                                                                      | every tick                        |
| `events`                                                                                     | `current` (`{ id: 'horde' \| 'gold' \| 'lost', t, dur, type, defs }`), `nextT`, `last`, `thiefT`, `thieves`, `lost` (the lost Pokémon: position, HP, `phase`, `follow`, marker `tx`/`ty`, `joins`).                                                             | every tick                        |
| `roster`                                                                                     | This run's wild Pokémon per tier and the 5 bosses (rolled at start).                                                                                                                                                                                            | static after start                |
| `spawner`, `pendingLevels`, `pathOrigins`, `pathTimer`, `allDownT`, `nextId`, `nextChoiceId` | Bookkeeping.                                                                                                                                                                                                                                                    | every tick                        |
| `config`                                                                                     | Choice timeout, debug flags.                                                                                                                                                                                                                                    | static                            |

## Events

Cosmetic or notifications only; gameplay never depends on them being delivered. Text is an i18n
key from `packages/data/i18n/en.json` plus params (`say`).

`say` (banner; `playerId` = only that player) · `cast` (move fired: kind, type, position, aim,
beam/dash `length`, `chain` points) · `slot`, `slot-locked` · `enemy-hurt` (amount, `label`
super/weak/crit, `shielded`, `byPlayer`, `moveType`: the attack's type for the number's colour) · `enemy-died` · `enemy-spawned` · `enemy-removed` ·
`enemy-healed` (recipient, position, restored HP) · `enemy-action` (shoot, charge, dash, strike, heal, shield, summon, jump, land, fuse, enrage; boss
`skill`) · `hazard` (hit) · `player-hurt` · `player-healed` · `player-down` · `player-revived` ·
`focus-sash` · `pickup` · `bomb` · `magnet` · `prop-hit` · `prop-broken` · `field-blast` · `biome` ·
`level-up` (team) · `move-learned` · `move-upgraded` · `move-evolved` · `item-equipped` ·
`shiny-caught` · `progress` (missions: `defeat {types, boss, legend}`, `chest`, `item {id}`,
`evolve {move}`, `rift-win {type}`, `rescue {dex}`, `run-end {time, level, coins, types, group}`;
`playerId: null` = everyone) · `choice-resolved` (`auto` if by timeout/disconnect) · `run-ended`.

Rifts and bonds: `rift-opened {x, y, ttl}` · `rift-closed {reason: expired | entered}` ·
`arena-entered {dex, shiny, arenaType, x, y, seconds}` · `arena-ended {result, dex}` (the banner;
the team goes back a few seconds later) · `arena-left {result}` · `bond-formed {playerId, moves}`.
Weather, events, interactables: `weather {kind | null, seconds}` · `run-event {id, phase: start |
end, pokemonType?, dex?}` · `thief {id, dex, loot}` · `lost-pokemon {phase: found | hurt | rescued |
scared | tired, dex, playerId?, joins?}` (on `rescued` with `joins`, a client shows "joins your team"
or "+150 coins, you already had it" from its own collection) · `altar {playerId, key, powerId}` ·
`trap {key, trap, x, y, r}`. `enemy-spawned` / `enemy-died` carry `legend`.

Progress is also aggregated per player in `players[].stats.progress`, which is the protocol's
`RunProgress` (plus `defeats` and `bossDefeats`), so missions don't depend on the events. Everyone
present gets `chestsOpened`, `riftWins` (arena type), `legendariesDefeated` and `rescued` (if the
lost Pokémon's 20% "joins you" roll succeeded).

## Run summary

`sim.runSummaryFor(playerId)` (or `playerRunSummary(sim.summary(), playerId)`) returns that
player's result in the protocol's shape, `RunSummary` from `@pokesurvivor/protocol`: what a solo
client sends to `POST /api/runs` and what co-op rooms pass to `recordCoopRun()`. `durationS` is
whole seconds; `level`, `kills`, `bosses`, tickets and shinies are the team's (as legacy co-op
shared them); `coins` is the end-of-run reward, legacy's formula (s/5 + kills/4 + 80 per boss +
coins picked up + 150 per rescued Pokémon the player already owned, if the caller passes `owns`)
× the player's coin multiplier (Fortune, Amulet Coin).

`summary()` is the richer version for the results screen: `{ time, ended, group, team,
players[] }` with, per player, the reward breakdown, moves, item, damage dealt, last hits, times
down, revives given and the progress totals. Granting shinies and the "+300 coins for a shiny you
already own" are the server's job.

## Co-op rules (as legacy co-op)

- One team XP bar and level. Each gem gives `value × average XP bonus / (1 + 0.6·(n − 1))`.
- Every level-up gives every player (connected or not; disconnected ones are auto-picked) their
  own server-generated cards; the game is paused until all are resolved. Item swaps (picking up a
  second held item) pause it too. Level-ups wait for pending swaps.
- From `tuning.lateGrowth.offers.fromMinute`, every level-up offer holds an offensive stat card
  (Power or Reflexes, whichever isn't capped) at a random slot; a ready evolution keeps its own.
- Momentum (`momentum.ts`, `tuning.momentum`): each kill credited to a player (last hit, or their
  burn/poison tick: `burnBy` / `poisonBy`) adds a stack, ×(1 + perStack · stacks) on their move
  damage; after `graceSeconds` without a kill the stacks drain at `decayPerSecond`.
- Enemies spawn around a random living player, out of everyone's view; rate ×(1 + 0.75·(n − 1)),
  HP ×(1 + 0.3·(n − 1)); bosses get another ×1.4 in a group.
- A downed player is revived by a teammate standing within 56 units for 3 s (progress decays at
  half speed when they step away), at 50% HP.

## Aiming

Every tick a player picks an auto target (`players.ts`, `updatePlayer`): for ranged moves the boss
if in range, else whatever touches it, else the nearest enemy; for the rest the other way round;
else the nearest rock or chest; else it aims where it walks. Targeted moves wait until that target
is in reach. With manual aim (`input.aim` set) the target is still picked, and still gates
targeted moves (there's something to fight), but `p.aim` is the input's angle. What that means
per move kind (`combat.ts`):

| Kind                                           | Manual aim                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| projectile, cone, beam, melee, boomerang, dash | Fires along the aim (they all use `p.aim`).                                                                    |
| chain                                          | Starts at the nearest enemy within ±45° (`MANUAL_AIM_CONE`) of the aim and in reach; waits until there is one. |
| meteor                                         | Falls on enemies within ±45° of the aim and in reach; the rest land at random along the aim.                   |
| turret                                         | Placed behind the aim (as with auto-aim); it shoots on its own.                                                |
| aura, nova, orbit, mine, trail, buff           | Unchanged: they don't aim.                                                                                     |

**Fire held** (`setInput(…, { aim, fire: true })`, manual aim only): aimed moves don't wait
for a target in reach; they fire along the aim as their cooldowns allow. A chain still needs an
enemy in the aim cone; meteors with no enemy in the cone land along the aim. Releasing (`fire`
absent or false) goes back to the normal rule.

A Pokémon faces its aim while attacking (`facingOf`), so the manual aim then. The aim comes in
through `setInput` like movement, so runs stay deterministic and replayable.

## Rifts, bonds, events, weather, interactables

Each is a module of functions over `Ctx`, stepped after hazards: `interact.ts`, `rift.ts`,
`runevents.ts`, `weather.ts`; bonds (`bonds.ts`) are offered after level-ups. Numbers come from
`tuning.json` (`rift`, `events`), `weather.json` and `world.json`.

- **Rifts** (`rift.ts`). From 75 s, a roll every 30 s opens a rift near a random living player with
  chance 0.2 × (1 + misses): at most 5 rolls (150 s) after the previous rift is over (expired after
  its 45 s, or the arena finished). Any player touching it takes the whole team to the arena: a
  walled circle carved into a far corner of the map (`world.arena`), themed after one of the
  legendary's types, with its weather forced. The map's enemies wait in `arena.stash`, projectiles,
  fields and hazards are cleared, nothing spawns and the biome doesn't change. The legendary (a boss
  with `legend`, walking, (3200 + 9 HP per second played) × late-game × co-op ×
  `rift.hpCurve` and `rift.coopHp` scaling) must fall
  within 120 s. Win: 3 tickets, 10 × 8 coins, a boss's loot with the ×10 ticket at
  `legendaryTicket10Chance`, a bond for everyone and `riftWins`/`legendariesDefeated`; the reward
  in the arena flies to you; 5 s later everyone is back where they were. Lose (everyone down 1.4 s,
  or the time limit): back after 1.2 s; the run never ends in the arena; the downed come back at 30%.
- **The "no rifts" fix.** Legacy skipped the roll while any boss was alive (late game: almost
  always), and its placement could fail silently after 24 tries with `misses` already reset. A boss
  no longer affects the schedule: the rift opens anyway, and if the team goes in the boss waits in
  the stash (deferring until the boss died would bring back the bug wherever bosses live long).
  Placement tries the legacy ring (380–560), a wider ring, then the free tile closest to the ring,
  then the player's own spot, and `misses` resets only once a rift is open. `rift.test.ts` runs 40
  minutes of bots: every rift opens ≤ 150 s after the previous one is over (≤ 320 s between
  openings), some while a boss is alive.
- **Bonds** (`bonds.ts`). Fusing moves into one slot, cast together. With a bonded group of 2–3
  (`BOND_MAX` 4) a bond adds one loose move (`mode: 'add'`); otherwise it pairs two loose moves
  (`pair`). A `bond` choice pauses everyone like level-up cards, with the same deadline, and
  auto-resolves to the first loose moves on timeout or disconnect. It's offered when nothing else is
  pending, outside the arena, to connected living players with a usable bond: one that can't be used
  yet (fewer than two loose moves) is saved until they learn another move.
- **Events** (`runevents.ts`). Every 240–300 s (retrying every 10 s while a boss is alive or in the
  arena), one of `horde` (30 s of one type: `hordeBag` feeds the spawner, plus a burst), `gold` (30 s
  of golden enemies: double XP, sometimes coins) or `lost` (bring the lost Pokémon to the marker
  within 120 s before enemies scare it: everyone heals 50%, 60 coins and a ticket drop, and with 20%
  it joins: `rescued`), never the same twice in a row. Two treasure thieves per run (first at
  120–240 s, then 240–360 s later, waiting 8 s at a time while a boss is alive): Gholdengo with a ×10
  ticket at `goldThiefChance` (0.125), else Meowth with coins; they escape after 15 s.
- **Weather** (`weather.ts`). From 120 s, a roll every 60 s (18%) brings a 55–75 s weather picked
  by the run biome's weights. Type multipliers (`weatherDamageMult`, used by both sides' attacks)
  and snow's slow (`weatherSpeedMult`) fade in and out over 3 s. Sand and snow chip 1.2% max HP
  every 2 s off non-immune players (never below 1 HP) and 2% + 1 off non-boss enemies.
- **Interactables** (`interact.ts`). Shared by everyone (legacy ran altars and springs on each
  player's machine): an altar gives the toucher a 25 s power once (`players[].power`), a spring
  heals 14% max HP/s and drains (refilling in 45 s), a locked chest opens after 3.5 s of anyone
  standing by it (slipping back at 1.5× when nobody is) and counts for everyone's
  `chestsOpened`, and a trap goes off under a player or a walking enemy, hitting enemies (poison,
  slow, explosion) and players within 70% of its radius.

## For the netcode

The game server and `packages/netclient` use this; see `docs/protocol.md`.

- **Static after start**: `roster`, `config`, `world.seed`, players' `dex`/`types`/`index`/`shiny`/
  `legendsBeaten`. Terrain and props are derived from the seed and `world.arena` (which changes only
  when the team enters or leaves an arena): send `world.broken`/`propHp`/`springs`/`chests`/
  `altarsUsed` as deltas only.
- **In the arena**, `arena.stash` holds the map's enemies (up to ~90 × `EnemyState`); clients don't
  need it until the team is back (then they're `enemies` again).
- **Changes every tick**: `tick`, `time`, `rng`, players' position/velocity/aim/timers, enemies'
  position and AI timers, projectiles (incl. orbs), fields, hazards, pulled pickups.
- **Large**: `enemies` (~64–90 × ~60 fields, plus a `def` that could be sent once per dex/tier),
  `pickups` (up to 420), `projectiles` (`hits`/`hitLog` are server-only and needn't be sent),
  `players[].moves[].stats` (changes only on level-ups).
- **Interest management**: enemies, projectiles and pickups have positions; legacy sent enemies
  within 950 units of each player.
- **Choices are state**: send `pendingChoices` in every snapshot; intents are idempotent
  (a repeated or stale `pickCard` returns `{ ok: false }` and changes nothing).
- **Determinism** makes replays possible: record `createSim` config and the input/intent calls per
  tick. Snapshots round-trip through JSON (`restoreSim`). The path-field cache is rebuilt from
  `pathOrigins` after a restore (identical unless a prop broke within the last 0.35 s).

## Performance

`pnpm test` runs the targeted regression suite, including a 18-minute calm rift schedule check
through arenas and living bosses. `pnpm test:slow` opts into the broad 20-minute four-player
progression run. Benchmarks and shield measurements remain separate opt-in commands.

`pnpm --filter @pokesurvivor/sim bench` (Node 22, one laptop core): a 20-minute 4-player run of
36,000 ticks takes ~12 s (0.34 ms/tick, rifts, arenas, events and weather included; 0.30–0.32 for
the 2a sim on the same machine). Late game at the enemy cap: mean 0.35–0.38 ms, p99 2.0–2.5 ms.
Stress, enemies spawned past the cap: 200 → 0.7–0.85 ms mean (p99 2.8–3.7), 400 → 1.2–1.6 ms (p99
3.2–4.6), 800 → 2.4–3.5 ms (p99 4.3–7.6); ranges are run-to-run noise. The budget is 33 ms. Enemies
use a 52-unit spatial grid (rebuilt each tick); path fields are 57×57 BFS per player every 0.35 s;
interactables are indexed per chunk.

## Differences from legacy

Ported faithfully (numbers and formulas); the changes are fixes, the multiplayer redesign, or
things now owned elsewhere:

- No host/guest split: every player is simulated the same way. Enemy shots, hazards and contact
  hit every player (legacy checked only the local one on each machine).
- Pending choices are state with deadlines; legacy co-op could stall forever on a lost message,
  and a second item pickup during an item choice replaced the overlay and left the game stuck in
  `choice`.
- "Off screen" rules (spawn ring, stragglers coming back ahead, projectile culling) use every
  player's view instead of the host's camera, with a fixed 768 × 432 view; a bomb hits what its
  collector can see.
- Fixed 1/30 s timestep instead of the frame's `dt`; line-of-sight re-checks and Focus Sash's
  cooldown use run time instead of `performance.now()` (pausing no longer counts toward it).
- Prop damage is kept in the state; legacy lost it (and re-grew rocks) when a chunk was evicted
  from its 400-chunk cache.
- After the last player goes down, the sim keeps running normally for the 1.3/1.6 s before the run
  ends (legacy slowed enemies to 30% during the faint animation in solo).
- Dropped: the unused aura `drain` path (no move has it).
- Rifts: the guaranteed schedule and placement fallback above (the "no rifts" bug). A win pulls
  every pickup on the map to you, as in legacy. Legacy left the arena's uncollectable leftovers
  and broken props behind (cleared), and let the lost Pokémon wander after a team in the arena
  (it waits on the map, its timer paused).
- Co-op: the rift legendary, events, weather, chip damage, springs, altars and trap effects apply to
  every player (legacy only checked the local one on each machine, or ran them per machine); rewards
  that legacy gave "each machine's player" (a bond per win, the rescue heal and collection) go to
  everyone present.
- Life Orb drains HP per second while attacking instead of per cast (see the data README's
  "Rebalanced after the port").

## Manual rift scaling measurements

`pnpm --filter @pokesurvivor/sim rifts --out=/absolute/path/rifts.jsonl` runs a manual
measurement matrix, separate from both `test` and `test:slow`. It does **not** change tuning.
The full matrix is deliberately substantial; use filters for quick experiments:

```sh
pnpm --filter @pokesurvivor/sim rifts --minutes=2,8,15 --seeds=7,99,2026 --players=1 --meta=half --archetypes=projectile --out=/tmp/rifts.jsonl
pnpm --filter @pokesurvivor/sim rifts:summary /tmp/rifts.jsonl > /tmp/rifts.csv
```

Defaults: minutes `2,4,6,8,10,12,15,20`, seeds `7,99,2026`, players `1,2,4`, meta
`none,half,max`, archetypes `projectile,melee,area`, profiles `natural,weak,typical,strong`.
Lists use comma-separated values. Meta means every permanent upgrade at zero, floor(max/2),
or max; half leaves the one-level Repertoire upgrade unbought. No bans or rerolls are used.
Separate filtered processes can write separate JSONL files, then pass all files to `rifts:summary`.

Natural calibration actually plays to each checkpoint, using the existing `pickFirst` upgrade,
item and bond policy, with deterministic loot/rift seeking, routes from the sim’s navigation field and local obstacle
avoidance. Natural bots select the slot with the highest summed damage/cooldown, so learning a
buff does not leave them unable to kill; Choice Band keeps its normal slot lock. The default
`--progression=protected` enables invulnerability **only during calibration** so late checkpoints
exist even for weak bots. Run `--progression=ordinary --calibrate-only` to audit ordinary survival;
omit `--calibrate-only` to measure surviving ordinary builds too. Protected builds are conditional
progression fixtures, **not evidence of human survival or a measured human median**. Snapshots retain
full earned loadouts, levels and rift wins, so their bias can be inspected.

Every arena trial uses damage enabled, a full heal, fresh cooldowns and no temporary overworld
buffs. `debugStartArena()` rolls a real legendary, arena, weather, boss skills and normal 120 s
limit at the requested run time. Homogeneous teams repeat Charmander, Bulbasaur or Pikachu.
The arena bot approaches to the shortest active move's range, strafes and seeks downed teammates;
it is a reproducible encounter policy, not skilled human play. Previous arena progress is not carried
into later trials; checkpoints come from the independent natural run.

Synthetic profiles explicitly rebuild legal move/stat cards from the median earned move progression
at that minute/meta/team/archetype. Their level-up budgets are 65%, 100%, 135% of the median earned
level minus one. Move plans are Ember/Flamethrower/Fire Spin/Swords Dance, Vine Whip/Quick Attack/
Tackle/Swords Dance, and Thunder Shock/Discharge/Thunderbolt/Swords Dance; the area profile activates
Discharge once learned. Typical uses the modal earned item and median previous rift wins for bonds;
weak has no item and one fewer bond; strong has Choice Band and one extra bond (an optimistic
previous-rift assumption, including at early checkpoints). Strong spends excess cards on offensive
stats. These are explicit sensitivity profiles; natural results are the calibration cross-check.
Each row includes the exact moves, levels, evolutions, slots, item and effective modifiers.

JSONL contains revision/config metadata, earned snapshots, progression survival and raw trials.
Trial metrics include spawn HP/contact/shot damage, win/nullable TTK, fight duration, damage taken
(sum of rounded `player-hurt` events, excluding Life Orb drain/weather chip), downs (including repeat
downs after revives), actual legend HP removed / fight seconds, and sustained single-target dummy
DPS. Damage and DPS are **team totals**; divide by player count for a per-player average.
The dummy uses 30 s of real casts at fixed close range, no incoming damage, neutral types, clear
weather and no terrain obstacles. Its collision radius and reference max HP match the rolled legend
(the latter preserves HP-relative poison damage), while a large current HP prevents overkill.
It measures potential DPS; arena DPS includes approach, dodging, type/weather effects, boss skills,
incidental allies and time spent down. Temporary powers are excluded from both.

The CSV summary keeps each archetype separate and reports seed count, wins, win rate, median and
min–max winning TTK, damage, spawn HP and dummy DPS. `cappedTtk*` substitutes 120 for losses solely
as a comparison score; it is **not** a kill time or a survival-analysis estimate. Never use only
winning TTK to declare a cell easy: consult win rate and downs too. Three seeds expose gross
sensitivity, not a precise win-probability estimate; increase `--seeds` before choosing final tuning.

For a controlled before/after tuning comparison, reuse the original earned checkpoints with
`--calibration=/absolute/path/results.jsonl` (or `.jsonl.gz`). The harness requires exactly one
matching snapshot per requested cell/seed/minute and includes those snapshots in its new output;
changing legend HP then cannot silently change the reference loadouts through earlier rift rewards.
Without this option it still earns fresh builds with the currently installed tuning.

`--probe-seconds=45` emits `kind: "probe"` rows instead of wins/TTK. It measures 45 seconds of
real arena movement and delivered damage, with incoming damage disabled and the legend's current
HP raised to prevent an early kill. Reference max HP is retained for HP-relative effects. This
isolates output from bot survival; it disables low-health boss phases and excludes reactive damage
that requires hurting a player. It is a damage-fitting diagnostic, not an invulnerable win-rate test.
The normal matrix continues to run with damage enabled. Metadata includes the rift tuning and probe
configuration. The CSV win/TTK summarizer intentionally ignores probe rows.

Legend HP tuning: `rift.hpCurve` supplies `m0` (onset in run minutes), `a` (growth per minute)
and `p` (exponent). The existing HP base is multiplied by
`(1 + a * max(0, minute - m0)) ** p`, with no cap after minute 20. Contact and shot damage
keep their existing formula. The curve has no dependency on player upgrades or prestige.

To refit the parametric HP curve, collect max-meta typical `--probe-seconds=45` rows for each
team size, then run `pnpm --filter @pokesurvivor/sim rifts:fit /tmp/probe-*.jsonl --m0=4 --target=45`.
This manual tool fits one multiplier against each minute/team median delivered DPS × target
seconds, with equal weight per group in log space. It removes the input's existing curve using
recorded tuning, searches the growth rate, solves the exponent, and prints rounded parameters
and every group's damage-equivalent duration. It never changes tuning or asserts balance values.

`--combat=protected` emits `kind: "offense"` diagnostic fights: real HP, boss phases and the normal
arena deadline, with player damage disabled. These isolate offensive kill duration from bot survival
and are never mixed into the ordinary trial win rate. The default remains `--combat=ordinary`.
Use the sustained damage probe for fitting; protected offense fights are a phase/uptime cross-check.

For the smoother, safety-biased refit, add `--objective=gentle --smooth-max=1.6 --max-seconds=75`.
It caps the first minute's HP multiplier and every minute/team reference duration, requires `p >= 1`,
and minimizes squared log error to the target plus extra penalties below 30 s (weight 0.5) and
above 60 s (weight 8). It searches the growth rate and solves the convex exponent objective by
bisection, then rechecks the constraints after rounding. `--objective=log` retains the original
symmetric fit. These constraints and measured balance numbers are manual-only, outside CI.

Iteration 3 co-op HP tuning: `rift.coopHp` adds
`1 + perPlayerAfterDuo * max(0, players - 2) * progress ** rampPower` on top of the existing
base/time/co-op HP. `progress` clamps `(minute - rampFromMinute) / (rampToMinute - rampFromMinute)`
to 0–1. Named endpoints and power preserve near-base early HP before reaching the full uplift.
Solo/duo HP, legend damage and prestige behavior stay unchanged.
Fit tools remove recorded time and co-op multipliers (including the superseded draft ramp)
when deriving a reference base HP. The v9 playtest is the iteration-3 anchor: old first-choice
half-meta fixtures underestimate that human group's output and are retained as diagnostics.

`poison.bossFactor` reduces the percent-HP part of poison against bosses and rift legends;
flat tick damage and regular enemies are unchanged. Neutral dummy DPS in the rift harness now
uses a legend target's status resistance, retaining a still, neutral target without boss AI.
Metadata records both rift and poison tuning. See the shared R5 report for measured results.

### Wild scaling diagnostics (manual)

`pnpm --filter @pokesurvivor/sim wilds --calibration=/absolute/path/rifts.jsonl.gz --out=/tmp/wilds.jsonl`
reuses the protected R5 checkpoint builds to measure regular wild damage and toughness independently
of rift legends. Omit `--calibration` to earn fresh protected builds with the same progression policy.
The default matrix uses minutes 2/4/6/8/10/12/15/20, none/half/max meta, 1/2/4 players, three
archetypes, seeds 7/99/2026 and both natural and synthetic typical profiles. The R5 synthetic typical
profile spends spare cards on max HP; compare it with natural builds before fitting defensive balance.

Each rolled roster member is forced through the real spawner, weighted exactly as normal tier
selection. The real player damage path supplies neutral and typed contact/shot damage after defence
and active-melee protection. Special skills, cap elites and the most recently unlocked boss are
reported separately. Per-hit and survival metrics sample the focal player (`p0`); teammates retain
their own earned builds. Effective HP excludes the melee discount, while hits-to-down include it.

Crowd fixtures keep the checkpoint time and loadout fixed: 15 seconds of invulnerable warmup,
then 30 seconds of real stationary or simple-kiting pressure. A health reserve prevents deaths in
the DPS probes while retaining hit invulnerability windows; separate ordinary stationary and kiting trials
record first focal-player down, censored at 30 seconds. No rifts, bosses, events or weather enter
these crowd probes. Potential team DPS uses 30 seconds of neutral close-range attacks against a
regular-sized dummy with the mean wild's reference max HP. HP/DPS is a potential TTK estimate.

Filter with `--meta`, `--players`, `--archetypes`, `--seeds` and `--minutes`; use
`--crowd-seconds=0` for static probes only. A small smoke run uses
`--meta=none --players=1 --archetypes=area --seeds=7 --minutes=2 --crowd-seconds=3`.
`pnpm --filter @pokesurvivor/sim --silent wilds:summary /tmp/wilds.jsonl` emits per-cell CSV medians,
ranges, one-shot counts and survival censor counts. It accepts multiple JSONL or gzip files and
rejects duplicate trials. These tools never run in CI and do not assert balance values.

For paired measurements, `--legacy` restores the old linear wild damage and disables the cap for
that fixture only. Output records `phase: before/after` and the configured spawner tuning; the
summarizer accepts both phases together. Fan-shot probes include the real per-projectile coefficient.

`spawner.damageCurve` replaces the old time multiplier with ordered minute/multiplier points. It
starts at minute zero, interpolates linearly and holds the final value; the existing multiplier after
minute 60 still applies. The fit targets six average neutral contact hits for half-meta natural
builds over minutes 2–20. It does not inspect a player's meta or scale enemy damage to their build.

`spawner.regularHitCapFraction` limits ordinary wild contact and ranged-shot damage after type,
defence and melee protection, before weather. Zero disables the cap. The default clear-weather
ceiling leaves room for the maximum weather boost; armour still reduces hits below that ceiling.
Only normal wild spawns and their ordinary summons/shots carry the source marker. Cap elites,
bosses, rift legends and telegraphed hazards are excluded; their damage coefficients are unchanged.
Source markers are optional plain state fields and survive projectile serialization after the
shooter disappears. Wild HP, damageK, spawn rates and player progression are unchanged.

`rift.coopHp.hpCurve` uses the same uncapped time formula for teams of three or four,
replacing `rift.hpCurve` only for those teams. It allows softening early co-op encounters
without changing solo/duo HP. The ramp controls extra co-op HP separately from time growth.

### Late-game player growth (manual R8 step 3)

`late-growth` extends the R5 earned-build policy to minutes 15/20/25/30/35, including three-player
teams. It runs outside CI and never changes gameplay tuning. First earn fresh protected checkpoints,
then measure them with the same revision and tuning:

```sh
pnpm --filter @pokesurvivor/sim late-growth --mode=calibrate --out=/tmp/late-builds.jsonl
pnpm --filter @pokesurvivor/sim late-growth --calibration=/tmp/late-builds.jsonl --multipliers=1,1.5,2 --out=/tmp/late.jsonl
```

Defaults: half/max meta, 1/3/4 players, projectile/melee/area, seeds 7/99/2026. Filter with `--meta`,
`--players`, `--archetypes`, `--seeds`, `--minutes`. Keep minute 15 in the calibration for growth
attribution. Separate processes can write different matrix shards; concatenate their JSONL files.
The audit observes real card offers before the existing first-choice bot resolves them, without
sampling extra randomness. `cards` rows contain cumulative offer/pick counts; `snapshot` rows retain
full earned builds.

`late` rows record neutral team single-target DPS, aggregate damage across 64 tightly packed neutral
targets, HP/DPS regular-wild TTK, actual kiting kills/s, admitted spawns/s, nominal spawn demand,
mean crowd size and time above 85% of the configured cap. Crowds use real terrain, typed enemies,
supports and cap elites, with 15 seconds of warmup followed by 60 seconds of observation. Invulnerable
players and disabled progression isolate offense, so these are not survival or human win rates.
Summons/surges can exceed the nominal cap. Admissions count actual spawn events, including summons;
nominal demand is the trickle formula before cap suppression, excluding surges/summons.

Dummy probes preserve regular max HP for status effects, suppress movement/knockback, use clear
weather and remove overkill. The 64-target probe is an upper bound on densely packed AoE throughput,
not a kills/s forecast. Synthetic typical builds reuse R5's four-move reconstruction, earned card
budget and bonds; surplus typical picks go to HP. They are independently reconstructed at each
checkpoint and may change move allocation non-monotonically. Natural runs retain exact earned builds;
their policy can underlevel or choose poor moves compared with humans.

Three-/four-player rifts at minute 20+ include a protected actual 120-second fight (timeouts have
`ttk: null`) and a protected 60-second sustained moving-legend probe. HP divided by probe DPS is an
extrapolation, not an observed completion time. Legend types, terrain, shields and status resistance still apply. The sustained probe holds
legend health above low-health phases; the actual fight retains those phases. Independent ablations freeze the minute-15 build at the later wild reference
HP, or remove only later Power/Reflexes picks, item changes or bonds. Their marginal effects overlap
and must not be summed. Level has no general attack multiplier; move upgrades/evolutions and passive
stats deliver its damage gains. Burn ticks and Rocky Helmet retaliation separately use team level.

`--multipliers=1,1.5,2` also replays each real crowd with fixture-only attack multipliers. This measures
sensitivity with frozen earned builds, not future progression, and poison/coverage can prevent linear
DPS gains. Metadata records production revision and effective tuning; cache files must match both.
