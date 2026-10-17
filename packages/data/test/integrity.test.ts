// Cross-file references: every id or dex one file mentions must exist where it points.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/index.js';
import { MOVE_KINDS, POKEMON_TYPES } from '../src/schemas/index.js';

const data = loadGameData();
const dexes = new Set(data.pokedex.map((p) => p.dex));
const moveIds = new Set(data.moves.moves.map((m) => m.id));
const statCardIds = new Set(data.levelUp.statCards.map((c) => c.id));

/** Values that aren't in `known`. */
const unknown = <T>(values: Iterable<T>, known: { has(v: T): boolean }) =>
  [...values].filter((v) => !known.has(v));

describe('pokedex', () => {
  it('has unique dex numbers and ids', () => {
    expect(data.pokemonByDex.size).toBe(data.pokedex.length);
    expect(data.pokemonById.size).toBe(data.pokedex.length);
  });

  it('only uses gens that have a gacha banner', () => {
    const gens = new Set(data.gacha.banners.map((b) => b.gen));
    expect(unknown(new Set(data.pokedex.map((p) => p.gen)), gens)).toEqual([]);
  });
});

describe('moves', () => {
  it('has unique ids across moves and their evolutions', () => {
    const ids = data.moves.moves.flatMap((m) => [m.id, ...(m.evolution ? [m.evolution.id] : [])]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('evolves only on existing level-up cards, with a boost for the kind', () => {
    for (const move of data.moves.moves) {
      if (!move.evolution) continue;
      expect(statCardIds.has(move.evolution.requires), move.id).toBe(true);
      expect(data.moves.evolutionBoosts[move.kind], move.id).toBeDefined();
    }
  });

  it('has an upgrade ladder for every kind and a stat key for every buff', () => {
    for (const kind of MOVE_KINDS) expect(data.moves.upgradeLadders[kind]).toBeDefined();
    for (const move of data.moves.moves) {
      expect(move.kind === 'buff', move.id).toBe(move.buffStat !== undefined);
      if (move.kind === 'buff') expect(move.evolution, move.id).toBeUndefined();
    }
  });

  it('has a starting move of the matching type for every type', () => {
    for (const type of POKEMON_TYPES) {
      const id = data.moves.startingMoves[type];
      expect(data.moveById.get(id)?.type, type).toBe(type);
    }
  });

  it('gives every type at least one move', () => {
    for (const type of POKEMON_TYPES)
      expect(data.movesByType.get(type)?.length, type).toBeGreaterThan(0);
  });
});

describe('starters', () => {
  it('are exactly the Pokémon flagged as starters', () => {
    const flagged = data.pokedex.filter((p) => p.starter).map((p) => p.dex);
    expect(data.starters.starters.map((s) => s.dex).sort((a, b) => a - b)).toEqual(flagged);
  });

  it('start with an existing move', () => {
    // Not necessarily of their own type: Psyduck starts with Confusion.
    expect(
      unknown(
        data.starters.starters.map((s) => s.startingMove),
        moveIds,
      ),
    ).toEqual([]);
  });

  it('only use known traits', () => {
    const traits = new Set(data.starters.traits.map((t) => t.id));
    expect(traits.size).toBe(data.starters.traits.length);
    const used = [
      ...data.starters.starters.flatMap((s) => s.traits),
      ...data.starters.personalityTest.flatMap((q) =>
        q.answers.flatMap((a) => Object.keys(a.points)),
      ),
    ];
    expect(unknown(used, traits)).toEqual([]);
  });
});

describe('enemies', () => {
  it('only reference Pokémon in the pokedex', () => {
    const { fixedBehaviors, summons } = data.enemies;
    const referenced = [
      ...fixedBehaviors.healer,
      ...fixedBehaviors.shielder,
      ...fixedBehaviors.bomber,
      ...summons.flatMap((s) => [s.summoner, s.minion]),
    ];
    expect(unknown(referenced, dexes)).toEqual([]);
  });

  it('has tiers and boss slots in time order', () => {
    const tiers = data.enemies.tiers.map((t) => t.from);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(tiers[0]).toBe(0);
    const slots = data.enemies.bossSlots.map((b) => b.at);
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
  });

  it('has non-legendary candidates for every tier and boss slot', () => {
    const normal = data.pokedex.filter((p) => !p.legendary);
    for (const range of [...data.enemies.tiers, ...data.enemies.bossSlots].map((t) => t.bst)) {
      expect(
        normal.some((p) => p.bst >= range[0] && p.bst <= range[1]),
        String(range),
      ).toBe(true);
    }
  });
});

describe('progression', () => {
  it('has unique ids', () => {
    expect(data.upgradeById.size).toBe(data.upgrades.length);
    expect(data.itemById.size).toBe(data.items.length);
    expect(data.statCardById.size).toBe(data.levelUp.statCards.length);
    expect(data.missionById.size).toBe(data.missions.daily.length + data.missions.weekly.length);
    expect(data.achievementById.size).toBe(data.achievements.achievements.length);
  });

  it('can hand out as many missions as it needs', () => {
    expect(data.missions.daily.length).toBeGreaterThanOrEqual(data.missions.dailyCount);
    expect(data.missions.weekly.length).toBeGreaterThanOrEqual(data.missions.weeklyCount);
  });

  it('has achievements in known categories', () => {
    const categories = new Set(data.achievements.categories.map((c) => c.id));
    expect(
      unknown(new Set(data.achievements.achievements.map((a) => a.category)), categories),
    ).toEqual([]);
  });

  it('has one achievement per legendary', () => {
    const legendaries = data.pokedex.filter((p) => p.legendary).map((p) => p.dex);
    const perLegendary = data.achievements.achievements.filter(
      (a) => a.metric === 'legendary-defeated',
    );
    expect(perLegendary.map((a) => a.dex)).toEqual(legendaries);
    expect(data.achievementById.get('legendaries-all')?.goal).toBe(legendaries.length);
  });

  it('sets "collect them all" goals from the data', () => {
    const goal = (id: string) => data.achievementById.get(id)?.goal;
    expect(goal('own-all')).toBe(data.pokedex.length);
    expect(goal('evolve-all')).toBe(data.moves.moves.filter((m) => m.evolution).length);
    // The legacy goal (11) is hard-coded; it must still match the item list.
    expect(goal('items-all')).toBe(data.items.length);
    expect(goal('arenas-all')).toBe(data.biomes.arenas.length);
  });
});

describe('gacha', () => {
  it('covers every rarity', () => {
    const all = [1, 2, 3, 4, 5];
    expect(data.gacha.rates.map((r) => r.rarity)).toEqual(all);
    expect(data.gacha.duplicateRefund.map((r) => r.rarity)).toEqual(all);
    expect(data.gacha.rarities.map((r) => r.rarity)).toEqual(all);
  });

  it('has one banner per generation, each with Pokémon', () => {
    for (const banner of data.gacha.banners) {
      expect(
        data.pokedex.some((p) => p.gen === banner.gen),
        banner.id,
      ).toBe(true);
    }
    expect(new Set(data.gacha.banners.map((b) => b.gen)).size).toBe(data.gacha.banners.length);
  });
});

describe('types', () => {
  it('lists every type once, with a chart row', () => {
    expect(data.types.types.map((t) => t.id)).toEqual([...POKEMON_TYPES]);
    for (const type of POKEMON_TYPES) expect(data.types.chart[type], type).toBeDefined();
  });
});

describe('world', () => {
  it('has one rift arena per type', () => {
    expect(data.biomes.arenas.map((a) => a.type).sort()).toEqual([...POKEMON_TYPES].sort());
  });

  it('gives every run biome a music track and weather weights', () => {
    for (const biome of data.biomes.runBiomes)
      expect(data.music[biome.music], biome.id).toBeDefined();
    expect(data.weather.biomeWeights).toHaveLength(data.biomes.runBiomes.length);
  });

  it('defines every liquid and weather the biomes use', () => {
    const weather = new Set(data.weather.kinds.map((k) => k.id));
    for (const biome of [...data.biomes.runBiomes, ...data.biomes.arenas]) {
      expect(data.world.liquids[biome.liquid], biome.name).toBeDefined();
    }
    for (const arena of data.biomes.arenas) {
      if (arena.weather) expect(weather.has(arena.weather), arena.type).toBe(true);
    }
  });
});

describe('megas', () => {
  it('lists Pokémon of the pokédex, each with its form body and an item icon', () => {
    expect(unknown(new Set(data.megas.map((m) => m.dex)), dexes)).toEqual([]);
    for (const m of data.megas) {
      expect(data.megaBodyByDex.get(m.dex)?.form, `${m.dex}`).toBe(m.kind);
      expect(
        existsSync(resolve(import.meta.dirname, `../../../apps/client/public/items/${m.item}.png`)),
        m.item,
      ).toBe(true);
    }
    expect(data.megaByDex.size).toBe(41);
  });
});
