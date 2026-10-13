import { z } from 'zod';
import { HexColorSchema, IdSchema, PokemonTypeSchema, RangeSchema, TextSchema } from './common.js';

export const LIQUIDS = ['water', 'swamp', 'lava', 'poison', 'spark', 'ice'] as const;
export const LiquidSchema = z.enum(LIQUIDS);
export const PropStyleSchema = z.enum(['tree', 'crystal', 'dead']);
export const WeatherIdSchema = z.enum(['sun', 'rain', 'sand', 'snow', 'fog']);
export type WeatherId = z.infer<typeof WeatherIdSchema>;

const Colors = z.array(HexColorSchema).min(1);

/** A biome the open map cycles through during a run. Colours are the tile painter's palette. */
export const RunBiomeSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  liquid: LiquidSchema,
  prop: PropStyleSchema,
  music: IdSchema,
  palette: z.strictObject({
    floor: Colors,
    dirt: Colors,
    speck: HexColorSchema,
    light: HexColorSchema,
    flowers: Colors,
    wallTop: Colors,
    wallLight: HexColorSchema,
    wallEdge: HexColorSchema,
    wallFace: Colors,
    wallFaceDark: HexColorSchema,
    liquid: HexColorSchema,
    liquidDeep: HexColorSchema,
    foam: HexColorSchema,
    shore: HexColorSchema,
    leaf: Colors,
    trunk: Colors,
    rock: Colors,
    grass: Colors,
  }),
});

/** The rift arena of each type: palette, terrain and weather. */
export const ArenaSchema = z.strictObject({
  type: PokemonTypeSchema,
  name: TextSchema,
  liquid: LiquidSchema,
  prop: PropStyleSchema,
  /** Share of the ground that is liquid (0 = none). */
  pools: z.number().min(0).max(1),
  /** Chance of a 2×2 pillar (cover) per block. */
  pillars: z.number().min(0).max(1),
  /** Prop densities. */
  props: z.partialRecord(z.enum(['tree', 'grass', 'rock']), z.number().positive()),
  weather: WeatherIdSchema.nullable(),
  palette: z.strictObject({
    floor: HexColorSchema,
    wall: HexColorSchema,
    liquid: HexColorSchema,
    foam: HexColorSchema.optional(),
    leaf: HexColorSchema,
    trunk: HexColorSchema,
    flowers: Colors,
    grass: HexColorSchema,
    rock: HexColorSchema,
  }),
});

export const BiomesFileSchema = z.strictObject({
  runBiomes: z.array(RunBiomeSchema).min(1),
  arenas: z.array(ArenaSchema).min(1),
});
export type BiomesFile = z.infer<typeof BiomesFileSchema>;

export const PROP_TYPES = [
  'tree',
  'rock',
  'chest',
  'grass',
  'altar',
  'spring',
  'big-chest',
  'trap',
] as const;

export const WorldFileSchema = z.strictObject({
  props: z.record(
    z.enum(PROP_TYPES),
    z.strictObject({
      solid: z.boolean(),
      /** `null` = indestructible. */
      hp: z.number().positive().nullable(),
      radius: z.number().positive(),
      /** Drawn flat on the ground. */
      flat: z.boolean(),
    }),
  ),
  /** Effect of standing in liquid; Pokémon of an `immune` type are unaffected. */
  liquids: z.record(
    LiquidSchema,
    z.strictObject({
      /** Speed multiplier. */
      slow: z.number().positive().optional(),
      /** Damage per tick, as a fraction of max HP, plus `flat`. */
      damage: z.number().positive().optional(),
      flat: z.number().positive().optional(),
      /** Seconds between damage ticks. */
      every: z.number().positive().optional(),
      color: HexColorSchema.optional(),
      slide: z.boolean().optional(),
      immune: z.array(PokemonTypeSchema),
    }),
  ),
  /** Stand next to a locked chest this long to open it. */
  bigChestOpenSeconds: z.number().positive(),
  trapRadius: z.number().positive(),
  /** Altars grant one of these powers for `altarPowerSeconds`. */
  altarPowerSeconds: z.number().positive(),
  altarPowers: z.array(
    z.strictObject({
      id: IdSchema,
      name: TextSchema,
      description: TextSchema,
      color: HexColorSchema,
      effect: z.strictObject({
        stat: z.enum(['attackMul', 'speedMul', 'cooldownMul', 'magnet']),
        op: z.literal('mul'),
        value: z.number().positive(),
      }),
    }),
  ),
});
export type WorldFile = z.infer<typeof WorldFileSchema>;

export const WeatherFileSchema = z.strictObject({
  kinds: z.array(
    z.strictObject({
      id: WeatherIdSchema,
      name: TextSchema,
      hint: TextSchema,
      icon: IdSchema,
      color: HexColorSchema,
      /** Screen tint: r, g, b (0–255) and alpha. */
      tint: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      /** Damage multiplier by attack type. */
      multipliers: z.partialRecord(PokemonTypeSchema, z.number().positive()),
      /** If set, Pokémon without one of these types slowly lose HP. */
      immuneTypes: z.array(PokemonTypeSchema).optional(),
      /** Slows Pokémon that aren't ice-type. */
      slows: z.boolean(),
    }),
  ),
  /** Relative weather weights for each run biome, by biome index. */
  biomeWeights: z.array(z.partialRecord(WeatherIdSchema, z.number().positive())),
  /** Weather can start after `startAfter` s; every `checkEvery` s it starts with `chance`. */
  startAfter: z.number().positive(),
  checkEvery: z.number().positive(),
  chance: z.number().positive().max(1),
  durationRange: RangeSchema,
});
export type WeatherFile = z.infer<typeof WeatherFileSchema>;
