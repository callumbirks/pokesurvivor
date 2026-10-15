// Game data: static JSON imports (bundled by Vite/esbuild, loaded by tsx/Vitest), validated with
// the zod schemas on first use, plus derived lookup maps. Works in Node and the browser.
import changelogJson from '../changelog.json' with { type: 'json' };
import achievementsJson from '../json/achievements.json' with { type: 'json' };
import biomesJson from '../json/biomes.json' with { type: 'json' };
import bodiesJson from '../json/bodies.json' with { type: 'json' };
import enemiesJson from '../json/enemies.json' with { type: 'json' };
import gachaJson from '../json/gacha.json' with { type: 'json' };
import itemsJson from '../json/items.json' with { type: 'json' };
import levelUpJson from '../json/levelup.json' with { type: 'json' };
import missionsJson from '../json/missions.json' with { type: 'json' };
import movesJson from '../json/moves.json' with { type: 'json' };
import musicJson from '../json/music.json' with { type: 'json' };
import pokedexJson from '../json/pokedex.json' with { type: 'json' };
import startersJson from '../json/starters.json' with { type: 'json' };
import tuningJson from '../json/tuning.json' with { type: 'json' };
import typesJson from '../json/types.json' with { type: 'json' };
import upgradesJson from '../json/upgrades.json' with { type: 'json' };
import weatherJson from '../json/weather.json' with { type: 'json' };
import worldJson from '../json/world.json' with { type: 'json' };
import {
  AchievementsFileSchema,
  BiomesFileSchema,
  BodiesFileSchema,
  ChangelogFileSchema,
  EnemiesFileSchema,
  GachaFileSchema,
  ItemsFileSchema,
  LevelUpFileSchema,
  MissionsFileSchema,
  MovesFileSchema,
  MusicFileSchema,
  PokedexSchema,
  StartersFileSchema,
  TuningFileSchema,
  TypeChartSchema,
  UpgradesFileSchema,
  WeatherFileSchema,
  WorldFileSchema,
  type Achievement,
  type AchievementsFile,
  type BiomesFile,
  type Body,
  type EnemiesFile,
  type GachaFile,
  type Item,
  type LevelUpFile,
  type Mission,
  type MissionsFile,
  type Move,
  type MovesFile,
  type MusicFile,
  type Pokemon,
  type PokemonType,
  type StarterSchema,
  type StartersFile,
  type StatCard,
  type TuningFile,
  type TypeChart,
  type Upgrade,
  type WeatherFile,
  type WorldFile,
} from './schemas/index.js';
import { indexBy, parseDataFile } from './util.js';
import type { z } from 'zod';

export * from './changelog.js';
export * from './i18n.js';
export * from './personality.js';
export { indexBy, parseDataFile } from './util.js';
export * from './schemas/index.js';

/**
 * The raw JSON of every data file, keyed by file name (without `.json`). Unvalidated. The sprite
 * manifest is separate: see `@pokesurvivor/data/sprites`. `changelog` is `changelog.json` at the
 * package root (see `loadChangelog`).
 */
export const rawData = {
  achievements: achievementsJson,
  biomes: biomesJson,
  bodies: bodiesJson,
  changelog: changelogJson,
  enemies: enemiesJson,
  gacha: gachaJson,
  items: itemsJson,
  levelup: levelUpJson,
  missions: missionsJson,
  moves: movesJson,
  music: musicJson,
  pokedex: pokedexJson,
  starters: startersJson,
  tuning: tuningJson,
  types: typesJson,
  upgrades: upgradesJson,
  weather: weatherJson,
  world: worldJson,
} as const;

/** The schema each data file must match. */
export const dataSchemas = {
  achievements: AchievementsFileSchema,
  biomes: BiomesFileSchema,
  bodies: BodiesFileSchema,
  changelog: ChangelogFileSchema,
  enemies: EnemiesFileSchema,
  gacha: GachaFileSchema,
  items: ItemsFileSchema,
  levelup: LevelUpFileSchema,
  missions: MissionsFileSchema,
  moves: MovesFileSchema,
  music: MusicFileSchema,
  pokedex: PokedexSchema,
  starters: StartersFileSchema,
  tuning: TuningFileSchema,
  types: TypeChartSchema,
  upgrades: UpgradesFileSchema,
  weather: WeatherFileSchema,
  world: WorldFileSchema,
} as const satisfies Record<keyof typeof rawData, z.ZodType>;

type Starter = z.infer<typeof StarterSchema>;

export interface GameData {
  pokedex: readonly Pokemon[];
  moves: MovesFile;
  types: TypeChart;
  starters: StartersFile;
  enemies: EnemiesFile;
  upgrades: readonly Upgrade[];
  items: readonly Item[];
  levelUp: LevelUpFile;
  missions: MissionsFile;
  achievements: AchievementsFile;
  music: MusicFile;
  gacha: GachaFile;
  biomes: BiomesFile;
  /** Collision size, hovering and shiny availability per Pokémon (derived from the sprites). */
  bodies: readonly Body[];
  world: WorldFile;
  weather: WeatherFile;
  tuning: TuningFile;

  pokemonByDex: ReadonlyMap<number, Pokemon>;
  pokemonById: ReadonlyMap<string, Pokemon>;
  moveById: ReadonlyMap<string, Move>;
  /** Moves of each type (every Pokémon can also learn the `normal` ones). */
  movesByType: ReadonlyMap<PokemonType, readonly Move[]>;
  starterByDex: ReadonlyMap<number, Starter>;
  upgradeById: ReadonlyMap<string, Upgrade>;
  itemById: ReadonlyMap<string, Item>;
  statCardById: ReadonlyMap<string, StatCard>;
  missionById: ReadonlyMap<string, Mission>;
  achievementById: ReadonlyMap<string, Achievement>;
  bodyByDex: ReadonlyMap<number, Body>;
}

function parse<K extends keyof typeof rawData>(key: K): z.infer<(typeof dataSchemas)[K]> {
  // TypeScript can't correlate the schema and its output through the indexed key.
  return parseDataFile(key, dataSchemas[key], rawData[key]) as z.infer<(typeof dataSchemas)[K]>;
}

let gameData: GameData | undefined;

/** Validates the game data (once) and returns it with its lookup maps. Throws if invalid. */
export function loadGameData(): GameData {
  if (gameData) return gameData;
  const pokedex = parse('pokedex');
  const moves = parse('moves');
  const starters = parse('starters');
  const upgrades = parse('upgrades');
  const items = parse('items');
  const levelUp = parse('levelup');
  const missions = parse('missions');
  const achievements = parse('achievements');
  const { bodies } = parse('bodies');
  const tuning = parse('tuning');
  for (const id of tuning.lateGrowth.offers.statIds) {
    if (!levelUp.statCards.some((c) => c.id === id)) {
      throw new Error(`tuning.lateGrowth.offers.statIds: no level-up stat card "${id}"`);
    }
  }

  const movesByType = new Map<PokemonType, Move[]>();
  for (const move of moves.moves) {
    const list = movesByType.get(move.type) ?? [];
    list.push(move);
    movesByType.set(move.type, list);
  }

  gameData = {
    pokedex,
    moves,
    types: parse('types'),
    starters,
    enemies: parse('enemies'),
    upgrades,
    items,
    levelUp,
    missions,
    achievements,
    music: parse('music'),
    gacha: parse('gacha'),
    biomes: parse('biomes'),
    bodies,
    world: parse('world'),
    weather: parse('weather'),
    tuning,

    pokemonByDex: indexBy(pokedex, (p) => p.dex, 'Pokémon dex'),
    pokemonById: indexBy(pokedex, (p) => p.id, 'Pokémon id'),
    moveById: indexBy(moves.moves, (m) => m.id, 'move id'),
    movesByType,
    starterByDex: indexBy(starters.starters, (s) => s.dex, 'starter'),
    upgradeById: indexBy(upgrades, (u) => u.id, 'upgrade id'),
    itemById: indexBy(items, (i) => i.id, 'item id'),
    statCardById: indexBy(levelUp.statCards, (c) => c.id, 'level-up card id'),
    missionById: indexBy([...missions.daily, ...missions.weekly], (m) => m.id, 'mission id'),
    achievementById: indexBy(achievements.achievements, (a) => a.id, 'achievement id'),
    bodyByDex: indexBy(bodies, (b) => b.dex, 'body dex'),
  };
  return gameData;
}
