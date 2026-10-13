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

The JSON was generated from the legacy game by `tools/legacy-data/convert.ts`, with every number
as the legacy game computed it at load time. **The JSON is now the source of truth**: edit it
directly (rebalancing, new content). Re-running the converter overwrites it; `--only sprites.json`
rewrites just the sprite manifest (after sprites change). `tools/legacy-data/legacy-ids.json` maps legacy ids to the
new ones.

| File                | Contents                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pokedex.json`      | 966 Pokémon: dex, id, name, types, game stats (hp, speed, attack), bst, rarity, gen, starter, legendary                     |
| `sprites.json`      | Sprite manifest (was `sprites-meta.js`): per Pokémon, sheet geometry per animation, shadow, hover, shiny, content hash      |
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
| `gacha.json`        | Costs, rarity weights, hard pity, ×10 guarantee, shiny rate, duplicate refunds, rarities, banners                           |
| `biomes.json`       | Run biomes (palette, liquid, music) and the 18 rift arenas (palette, terrain, weather)                                      |
| `world.json`        | Map props, liquid effects, locked-chest/trap/altar constants and altar powers                                               |
| `weather.json`      | Weather kinds (multipliers, immune types, slow), weights per biome, schedule                                                |
| `tuning.json`       | Named constants from the legacy spawner, rifts, events, combat and pickups                                                  |

Display text in data files is English. Text for screens (buttons, toasts, HUD) goes in
`i18n/en.json`, never in code. `test/english.test.ts` fails if anything Spanish appears.

## Left in code for the sim port

Only named constants and tables were extracted. Formula coefficients written inline in legacy
logic stay with that logic, to be ported (and, if useful, lifted into `tuning.json`) in phase 2:

- `enemies.js`: `behaviorOf()` (type and dex-hash rules), `defFor()` (per-behaviour stat factors,
  ranged cooldowns and ranges), the runner pick, boss ×1.35 HP / ×1.2 damage, `scale()` and
  `bossScale()`.
- `spawner.js`: `rate()`, the `hpK` curve, surge timing; `combat.js` damage resolution;
  `hazards.js`; `pathing.js`.
- `interact.js`: spring heal/drain rates and trap damage per kind; `weather.js` chip damage and
  snow slow; `events.js` and `rift.js` rewards.
- `upgrades.js` cost formula (`round(base · grow^level / 10) · 10`, documented on the schema) and
  `gacha.js` pool fallback (`poolNear`).
