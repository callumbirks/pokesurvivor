# @pokesurvivor/data

Game data as JSON (`json/`), the zod schemas that validate it (`src/schemas/`), and the UI strings
(`i18n/en.json`).

```ts
import { loadGameData, t } from '@pokesurvivor/data';
import { loadSpriteManifest, spriteUrl } from '@pokesurvivor/data/sprites'; // large, separate
import { MoveSchema, type Move } from '@pokesurvivor/data/schemas'; // schemas and types only

const data = loadGameData(); // validated once, then memoized; throws on invalid data
data.pokemonByDex.get(25); // also pokemonById, moveById, movesByType, itemById, …
t('hud.aWildAppeared', { 0: 'Pikachu' }); // "A wild Pikachu appeared!"
```

## Files

**The JSON is the source of truth**: edit it directly for rebalancing and new content.
The only generated files are `sprites.json` and `bodies.json`:

```sh
pnpm --filter @pokesurvivor/tools generate-sprites
```

The generator reads only `assets/`. `assets/sprite-metadata.json` records each sheet's frame
geometry, durations, anchors, shadow size and hovering flag (these cannot be inferred from PNG
pixels). When replacing a sheet, update that metadata if its geometry or animation timing changes;
when adding Pokémon, add metadata too. Shiny availability is detected from the `s/` directory.
The generator validates sheet dimensions, calculates opaque bounds and content hashes, derives
collision bodies, then validates both outputs against their schemas before writing them.

| File                | Contents                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pokedex.json`      | 966 Pokémon: dex, id, name, types, game stats (hp, speed, attack), bst, rarity, gen, starter, legendary                     |
| `sprites.json`      | Sprite manifest (was `sprites-meta.js`): per Pokémon, sheet geometry per animation, shadow, hover, shiny, content hash      |
| `bodies.json`       | Derived from `sprites.json` for the sim: collision radius, height, hovering and shiny availability per Pokémon              |
| `moves.json`        | 59 moves with stats, upgrade ladders per kind, evolution (name + required level-up card) and boosts, starting move per type |
| `types.json`        | Type names and colours, the games' chart, and the survivor's softened multipliers and clamp                                 |
| `starters.json`     | Personality traits, starters (dex, starting move, traits) and the personality test                                          |
| `enemies.json`      | Spawn tiers, boss slots, late-game scaling constants, fixed behaviours and summoner → minion pairs                          |
| `upgrades.json`     | Permanent upgrades: cost curve, max level and per-level value                                                               |
| `items.json`        | Held items: stat effects while held, plus params for the ones that react to events                                          |
| `levelup.json`      | Level-up stat cards (effect, pick cap) and the card-offer weights                                                           |
| `missions.json`     | Daily and weekly mission templates (event, filter, value, goals, reward, text with `{count}`/`{type}`)                      |
| `achievements.json` | Categories and achievements (metric, goal, reward, title), including one per legendary                                      |
| `music.json`        | Synth scores for the menu, the three biomes, bosses and rifts                                                               |
| `gacha.json`        | Costs, rarity weights, soft and hard pity, ×10 guarantee, shiny rate, duplicate refunds, rarities, banners                  |
| `biomes.json`       | Run biomes (palette, liquid, music) and the 18 rift arenas (palette, terrain, weather)                                      |
| `world.json`        | Map props, liquid effects, locked-chest/trap/altar constants and altar powers                                               |
| `weather.json`      | Weather kinds (multipliers, immune types, slow), weights per biome, schedule                                                |
| `tuning.json`       | Named constants from the legacy spawner, rifts, events, combat and pickups                                                  |

`changelog.json` (at the package root, not in `json/`) is the player-facing changelog: released
versions newest first and an `unreleased` block that pull requests add lines to. `loadChangelog()`
validates it, `versionLabel()` gives the build's version (`v7`, `v7+dev`, `dev`), and
`renderChangelogMarkdown()` / `releaseChangelog()` back `pnpm changelog` and `pnpm release`
(`tools/changelog/cli.ts`). See [CONTRIBUTING.md](../../CONTRIBUTING.md#changelog).

### Rebalanced after the port

These values differ from the original game:

- `gacha.json`: 5★ weight 0.6 (legacy 1.5, the difference moved to 1★: 45.9), soft pity from the
  74th pull (+6 points of 5★ chance per pull; legacy had none) and hard pity 90 (legacy 70).
- `tuning.json` `pickups`: a boss drops a ×10 ticket with `bossTicket10Chance` 0.1 (legacy 1/3),
  a rift legendary with `legendaryTicket10Chance` 0.2 (legacy 0.5).
- `tuning.json` `events.goldThiefChance`: the chance a treasure thief is Gholdengo, who drops a
  ×10 ticket, instead of Meowth, who drops coins: 0.125 (hard-coded 0.25 in legacy
  thief spawning). The sim's event port reads it.
- `items.json` `life-orb`: still +30% damage, but instead of 1% max HP per cast (which pinned
  fast moves and bonds at 1 HP) it drains `drainPerSecond` 1.5% of max HP per second while the
  player is attacking (a cast within `attackingWindowS` 1 s, or the move's cooldown if longer),
  never below `drainFloor` 30% of max HP.

Display text in data files is English. Text for screens (buttons, toasts, HUD) goes in
`i18n/en.json`, never in code. `test/english.test.ts` fails if anything Spanish appears.

## Logic

Formula coefficients live in `packages/sim/src/`: enemy behaviours and scaling in `data.ts`,
spawn rates in `spawner.ts`, damage in `combat.ts`, hazards in `hazards.ts`, and arena/event
rules in `rift.ts` and `runevents.ts`. Named tuning tables live in the JSON above.

The upgrade cost formula (`round(base · grow^level / 10) · 10`, documented on the schema) and the
gacha rules (`poolNear` fallback, pity, ×10 guarantee, shiny re-pick) live in the server
(`apps/server/src/economy/config.ts`, `apps/server/src/gacha/engine.ts`), which owns the economy.
The personality-test scoring is shared: `personalityScores`, `topTrait` and `bestStarters`.

Rift legend HP adds a parametric multiplier to its existing time/late-game/co-op base:
`(1 + a * max(0, minute - m0)) ** p`. `tuning.json` → `rift.hpCurve` exposes the onset
`m0` in run minutes, growth rate `a`, and exponent `p`; the schema documents and validates
them. This controls HP only and keeps growing beyond the fitted window. It does not scale
legend damage or depend on a player's prestige.

`rift.coopHp` adds a late large-team multiplier after `hpCurve.m0`:
`1 + perPlayerAfterDuo * max(0, players - 2) * clamp((minute - m0) / rampMinutes, 0, 1) ** rampPower`.
Its named fields control the per-player uplift, ramp duration in minutes, and eased onset.
The original early co-op base, solo/duo HP, legend damage and prestige behavior stay unchanged.
