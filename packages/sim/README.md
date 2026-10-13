# @pokesurvivor/sim

The headless game simulation: a port of the legacy run (`legacy/js/game.js`, `world/world.js`,
`entities/*`, `systems/{combat,spawner,levelup,pathing,hazards}.js`) for 1–4 players. The server
runs it for co-op rooms; the browser runs it in a Web Worker for solo. No DOM, Canvas or Audio,
and deterministic: one seeded RNG in the state, a fixed 30 Hz tick, no wall clock (ESLint bans
`Math.random`, `Date.now`, `performance` and timers in `src/`).

Phase 2a is the core loop. Phase 2b adds rifts and the legendary arena, bonds, events, weather
and interactables; see [Hooks for 2b](#hooks-for-2b).

```ts
import { createSim, drainTicks } from '@pokesurvivor/sim';

const sim = createSim({
  seed: 1234,
  players: [
    { id: 'u1', dex: 25, shiny: false, upgrades: { attack: 3, 'max-hp': 5 } },
    { id: 'u2', dex: 4, bannedMoves: ['harden'], moveBindings: ['ember', null] },
  ],
  choiceTimeoutSeconds: 30, // null for solo: choices wait forever
});

sim.setInput('u1', { moveX: 1, moveY: 0 }); // persists; `slot: 2` switches move once
sim.step(); // one tick (1/30 s)
for (const c of sim.state.pendingChoices) {
  if (c.kind === 'level-up')
    sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: c.options[0].id });
}
const events = sim.drainEvents(); // cosmetic: sounds, numbers, VFX, banners
```

## API

| Call                                                          | What it does                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSim({ seed, players, choiceTimeoutSeconds?, debug? })` | New run. `players[i]`: `id`, `dex`, `shiny?`, `upgrades?` (permanent upgrade levels by id, clamped to each max), `bannedMoves?`, `moveBindings?` (preferred slot per move). `debug`: `invulnerable`, `noSpawns`. |
| `setInput(playerId, { moveX, moveY, slot? })`                 | Movement (clamped to length 1) persists until changed. `slot` is a one-shot request applied on the next running tick: send it once per key press.                                                                |
| `submitIntent(playerId, intent)`                              | `pickCard {choiceId, cardId}`, `pickItem {choiceId, itemId}` (the item to hold), `reroll {choiceId}`, `cycleSlot {dir}`. Returns `{ ok }` or `{ ok: false, error }`; never throws on bad input.                  |
| `step()`                                                      | One tick. While any choice is pending it only counts ticks toward the choices' deadlines (the game is paused for everyone).                                                                                      |
| `setConnected(playerId, bool)`                                | Disconnected players stand still, don't attack, can't be hurt, aren't targeted or counted for difficulty/XP, and their pending choices resolve at once. The reconnect grace is the caller's.                     |
| `removePlayer(playerId)`                                      | Left for good (or grace ran out). Stays in `state.players` with `left: true` for the summary. The run ends when everyone has left.                                                                               |
| `drainEvents()`                                               | Events since the last call.                                                                                                                                                                                      |
| `state`, `paused`, `ended`                                    | Read the state directly (treat it as read-only).                                                                                                                                                                 |
| `summary()`                                                   | Per-player run results (see below).                                                                                                                                                                              |
| `hash()`                                                      | Fingerprint of the state (cyrb53 of its JSON). Same seed + same calls → same hash.                                                                                                                               |
| `restoreSim(state)`                                           | A sim from a snapshot (a deep copy of `state`, e.g. JSON). It continues exactly like the original.                                                                                                               |
| `propsInRect`, `propHp`, `terrainRaw`                         | World queries for renderers (terrain is a pure function of `world.seed`; props of the seed and `world.broken`).                                                                                                  |

The run ends when every remaining player has been down for 1.3 s (solo) / 1.6 s (group), or when
everyone has left: `state.ended = { reason: 'all-down' | 'everyone-left', tick, time }`.

## State

`state` is plain JSON data: no classes, closures, Maps, Sets or `Infinity`. Caches derived from it
(world chunks, the enemy grid, path fields) live outside it and are rebuilt.

| Key                                                                                          | Contents                                                                                                                                   | Changes                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `tick`, `time`                                                                               | Ticks stepped (paused ones too) and seconds played (running only).                                                                         | every tick                    |
| `rng`                                                                                        | 4 × uint32 (sfc32).                                                                                                                        | every tick                    |
| `players[]`                                                                                  | Position, velocity, aim and target, HP and stats, buffs, moves (`stats` already levelled), slots, item, input, revive progress, run stats. | every tick (position, timers) |
| `enemies[]`                                                                                  | ~64 alive (cap) plus minions and bosses: position, HP, statuses, AI state (`phase`, boss `ai`, `jump`), `def` (base stats).                | every tick                    |
| `projectiles[]`                                                                              | Player and enemy shots, orbs (`orb: true`). Tens at a time. `hits` / `hitLog` are what they already hit.                                   | every tick                    |
| `fields[]`, `hazards[]`                                                                      | Mines/meteors/turrets/trail pools; telegraphed enemy attacks. A handful.                                                                   | every tick                    |
| `pickups[]`                                                                                  | XP gems, coins and loot on the ground: up to 420 (then the oldest gems merge). Mostly still unless pulled.                                 | on drops/pulls                |
| `team`                                                                                       | Shared level, XP, kills, bosses, coins, tickets, shinies.                                                                                  | on events                     |
| `pendingChoices[]`                                                                           | `{ id, playerId, kind: 'level-up', level, options[] }` or `{ kind: 'item', held, found }`, each with `deadlineTick`.                       | on level-ups / item swaps     |
| `world`                                                                                      | `seed`, `biome` (index, every 4 min), `broken` (tile keys of destroyed props), `propHp` (damaged props).                                   | rarely; grows slowly          |
| `roster`                                                                                     | This run's wild Pokémon per tier and the 5 bosses (rolled at start).                                                                       | static after start            |
| `spawner`, `pendingLevels`, `pathOrigins`, `pathTimer`, `allDownT`, `nextId`, `nextChoiceId` | Bookkeeping.                                                                                                                               | every tick                    |
| `config`                                                                                     | Choice timeout, debug flags.                                                                                                               | static                        |

## Events

Cosmetic or notifications only; gameplay never depends on them being delivered. Text is an i18n
key from `packages/data/i18n/en.json` plus params (`say`).

`say` (banner; `playerId` = only that player) · `cast` (move fired: kind, type, position, aim,
beam/dash `length`, `chain` points) · `slot`, `slot-locked` · `enemy-hurt` (amount, `label`
super/weak/crit, `shielded`, `byPlayer`) · `enemy-died` · `enemy-spawned` · `enemy-removed` ·
`enemy-action` (shoot, charge, dash, strike, heal, shield, summon, jump, land, fuse, enrage; boss
`skill`) · `hazard` (hit) · `player-hurt` · `player-healed` · `player-down` · `player-revived` ·
`focus-sash` · `pickup` · `bomb` · `magnet` · `prop-hit` · `prop-broken` · `field-blast` · `biome` ·
`level-up` (team) · `move-learned` · `move-upgraded` · `move-evolved` · `item-equipped` ·
`shiny-caught` · `progress` (missions: `defeat {types, boss, legend}`, `item {id}`,
`evolve {move}`, `run-end {time, level, coins, types, group}`; `playerId: null` = everyone) ·
`choice-resolved` (`auto` if by timeout/disconnect) · `run-ended`.

Progress is also aggregated per player in `players[].stats.progress`, which is the protocol's
`RunProgress` (plus `defeats` and `bossDefeats`), so missions don't depend on the events.

## Run summary

`sim.runSummaryFor(playerId)` (or `playerRunSummary(sim.summary(), playerId)`) returns that
player's result in the protocol's shape, `RunSummary` from `@pokesurvivor/protocol`: what a solo
client sends to `POST /api/runs` and what co-op rooms pass to `recordCoopRun()`. `durationS` is
whole seconds; `level`, `kills`, `bosses`, tickets and shinies are the team's (as legacy co-op
shared them); `coins` is the end-of-run reward, legacy's formula (s/5 + kills/4 + 80 per boss +
coins picked up) × the player's coin multiplier (Fortune, Amulet Coin).

`summary()` is the richer version for the results screen: `{ time, ended, group, team,
players[] }` with, per player, the reward breakdown, moves, item, damage dealt, last hits, times
down, revives given and the progress totals. Granting shinies and the "+300 coins for a shiny you
already own" are the server's job.

## Co-op rules (as legacy co-op)

- One team XP bar and level. Each gem gives `value × average XP bonus / (1 + 0.6·(n − 1))`.
- Every level-up gives every player (connected or not; disconnected ones are auto-picked) their
  own server-generated cards; the game is paused until all are resolved. Item swaps (picking up a
  second held item) pause it too. Level-ups wait for pending swaps.
- Enemies spawn around a random living player, out of everyone's view; rate ×(1 + 0.75·(n − 1)),
  HP ×(1 + 0.3·(n − 1)); bosses get another ×1.4 in a group.
- A downed player is revived by a teammate standing within 56 units for 3 s (progress decays at
  half speed when they step away), at 50% HP.

## Hooks for 2b

- **Systems**: `Sim.step()` has a marked spot for interactables, rifts, events and weather; each is
  a module of functions over `Ctx` (state, data, RNG, events, caches), like the existing ones.
- **Weather**: `weather.ts` (`weatherDamageMult`, `weatherSpeedMult`) is already used by combat
  and movement; it returns 1 for now.
- **Bonds**: slots are lists of move ids and every move of the active slot is cast
  (`activeGroup`); `players[].bonds` exists. Add a `bond` choice kind to `PendingChoice`.
- **Rifts**: `world.ts` `terrainRaw`/`placeProps` is where the arena carves in; enemies have
  `legend`; the spawner has a marked "in arena" early return; loot for `legend` in `killEnemy`.
- **Events**: `golden` enemies, `thief` behaviour (with `life` and `def.loot`), `spawnBurst()` for
  hordes and the horde bag in `pickDef` are in place.
- **Interactables**: altars, springs, locked chests and traps are already generated as props
  (`specialsNear`); `destroyProp` marks where traps and big chests break; `xpToNextLevel()` is the
  locked chest's XP.

## For the netcode (phase 3c)

- **Static after start**: `roster`, `config`, `world.seed`, players' `dex`/`types`/`index`/`shiny`.
  Terrain and props are derived from the seed: send `world.broken`/`propHp` as deltas only.
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

`pnpm --filter @pokesurvivor/sim bench` (Node 22, one laptop core): a 20-minute 4-player run of
36,000 ticks takes ~10 s (0.29 ms/tick). Late game at the enemy cap: mean 0.28 ms, p99 1.7 ms.
Stress, enemies spawned past the cap: 200 → 0.6 ms mean (p99 2.0), 400 → 1.1 ms (p99 2.5), 800 →
2.2 ms (p99 3.7). The budget is 33 ms. Enemies use a 52-unit spatial grid (rebuilt each tick);
path fields are 57×57 BFS per player every 0.35 s.

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
- Life Orb drains HP per second while attacking instead of per cast (see the data README's
  "Rebalanced after the port").
