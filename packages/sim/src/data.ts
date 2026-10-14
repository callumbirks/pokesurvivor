// Read-only game data and the lookups the systems need, built once from @pokesurvivor/data.
// Formula constants that legacy kept inline in its logic are ported here in this module.
import {
  loadGameData,
  type Body,
  type EnemyBehavior,
  type GameData,
  type Item,
  type Move,
  type MoveStats,
  type Pokemon,
  type PokemonType,
  type StatCard,
  type Upgrade,
} from '@pokesurvivor/data';
import { clamp, hash2 } from './math.js';
import type { BossDef, EnemyDef } from './state.js';

export interface LiquidEffect {
  slow?: number;
  damage?: number;
  flat?: number;
  every?: number;
  slide?: boolean;
}

export interface PropDef {
  solid: boolean;
  /** null: indestructible. */
  hp: number | null;
  r: number;
  flat: boolean;
}

/** Permanent upgrades resolved into player modifiers (original `Upgrades.perks`). */
export interface Perks {
  hp: number;
  attackMul: number;
  speedMul: number;
  cooldownMul: number;
  damageReduction: number;
  regen: number;
  magnetMul: number;
  xpMul: number;
  coinMul: number;
  startMoves: number;
  crit: number;
  rerolls: number;
  bans: number;
}

export interface SimData {
  game: GameData;
  body(dex: number): Body;
  hasSprite(dex: number): boolean;
  move(id: string): Move;
  /** Moves a Pokémon of these types can learn: every `normal` move, then its types' (legacy order). */
  movePool(types: readonly PokemonType[]): string[];
  startingMove(dex: number): string;
  /** Stats of a move at `level` (upgrade ladder applied), optionally evolved. */
  moveStats(id: string, level: number, evolved: boolean): MoveStats;
  maxMoveLevel(id: string): number;
  /** Softened type multiplier of an attack against a defender's types. */
  typeMult(attack: PokemonType | null, defender: readonly PokemonType[]): number;
  perks(levels: Readonly<Record<string, number>>): Perks;
  item(id: string): Item;
  statCard(id: string): StatCard;
  /** The liquid of a run biome (by index, cycling). */
  biomeLiquid(biome: number): string;
  /** Effect of a liquid (`world.liquids` id) on a Pokémon of these types. */
  liquidEffect(liquid: string, types: readonly PokemonType[]): LiquidEffect;
  /** The liquid hurts (lava, poison, sparks): walkers path around it. */
  liquidHurts(liquid: string): boolean;
  prop(type: string): PropDef;
  behaviorOf(p: Pokemon): EnemyBehavior;
  /** Wild Pokémon eligible for each spawn tier. */
  tierCandidates: readonly (readonly Pokemon[])[];
  enemyDef(p: Pokemon, tier: number): EnemyDef;
  bossDef(p: Pokemon, slot: number): BossDef;
  /** Legacy `Enemies.scale(t)` / `bossScale(t)` and the late-game multiplier. */
  late(t: number): number;
}

const DEFAULT_BODY_WIDTH = 32;
const DEFAULT_BODY_ANCHOR = 24;

// Pokémon game stats → approximate base stats (inverse of the original PokéAPI conversion).
const baseHp = (p: Pokemon) => (p.hp - 70) / 0.45;
const baseSpeed = (p: Pokemon) => (p.speed - 78) / 0.42;

let cached: SimData | undefined;

export function simData(): SimData {
  if (cached) return cached;
  const game = loadGameData();
  const { moves: movesFile, types, enemies, world } = game;

  const MULT = new Set<string>(movesFile.modifierRules.multiplicative);
  const ADD = new Set<string>(movesFile.modifierRules.additive);
  const applyMods = (s: MoveStats, mods: MoveStats) => {
    for (const [k, v] of Object.entries(mods) as [keyof MoveStats, number][]) {
      const cur = s[k];
      if (MULT.has(k) && cur != null) s[k] = cur * v;
      else if (ADD.has(k)) s[k] = (cur ?? 0) + v;
      else s[k] = v;
    }
  };

  const moveById = game.moveById;
  const move = (id: string): Move => {
    const m = moveById.get(id);
    if (!m) throw new Error(`unknown move ${id}`);
    return m;
  };
  const ladder = (m: Move) => movesFile.upgradeLadders[m.kind];

  const pool = new Map<PokemonType, string[]>();
  for (const m of movesFile.moves) {
    const list = pool.get(m.type) ?? [];
    list.push(m.id);
    pool.set(m.type, list);
  }

  const soft: Record<number, number> = {
    2: types.softened.superEffective,
    0.5: types.softened.notVeryEffective,
    0: types.softened.immune,
  };

  const upgradeLevel = (u: Upgrade, levels: Readonly<Record<string, number>>) =>
    Math.max(0, Math.min(u.maxLevel, Math.floor(Number(levels[u.id]) || 0)));
  const upgrade = (id: string) => {
    const u = game.upgradeById.get(id);
    if (!u) throw new Error(`unknown upgrade ${id}`);
    return u;
  };

  const runBiomes = game.biomes.runBiomes;
  const biomeLiquid = (biome: number) => {
    const n = runBiomes.length;
    return runBiomes[((biome % n) + n) % n]?.liquid ?? 'water';
  };
  const liquidOf = (liquid: string) =>
    world.liquids[liquid as keyof typeof world.liquids] ?? world.liquids.water;

  const heal = new Set(enemies.fixedBehaviors.healer);
  const shield = new Set(enemies.fixedBehaviors.shielder);
  const bomb = new Set(enemies.fixedBehaviors.bomber);
  const summons = new Map(enemies.summons.map((s) => [s.summoner, s.minion]));
  const hasSprite = (dex: number) => game.bodyByDex.has(dex);

  // original implementation behaviorOf()
  const behaviorOf = (p: Pokemon): EnemyBehavior => {
    const t = p.types;
    const h = hash2(p.dex, 7, 11);
    const has = (...xs: PokemonType[]) => xs.some((x) => t.includes(x));
    if (heal.has(p.dex)) return 'healer';
    if (shield.has(p.dex)) return 'shielder';
    if (bomb.has(p.dex)) return 'bomber';
    const minion = summons.get(p.dex);
    if (minion !== undefined && hasSprite(minion)) return 'summoner';
    if (has('bug') && h >= 0.6 && h < 0.78) return 'summoner';
    if (has('electric', 'psychic', 'dragon', 'ice') && h < 0.18) return 'beamer';
    if (has('fire', 'ground', 'poison') && h < 0.18) return 'zoner';
    if (has('water', 'grass', 'bug', 'fairy') && h >= 0.18 && h < 0.32) return 'fan';
    if (has('fighting', 'ground', 'normal', 'rock') && h >= 0.42 && h < 0.56) return 'jumper';
    if (has('psychic', 'electric', 'ghost', 'fairy') && h < 0.4) return 'ranged';
    if (has('fire', 'water', 'poison', 'ice') && h < 0.22) return 'ranged';
    if (has('fighting', 'normal', 'ground', 'rock', 'dragon', 'steel', 'dark') && h < 0.4)
      return 'charger';
    if (baseHp(p) > 95 && baseSpeed(p) < 50) return 'tank';
    return 'chase';
  };

  // original implementation defFor()
  const enemyDef = (p: Pokemon, ti: number): EnemyDef => {
    const tier = enemies.tiers[ti];
    if (!tier) throw new Error(`no tier ${ti}`);
    const hpK = clamp(baseHp(p) / 65, 0.7, 1.6);
    const spdK = clamp(0.75 + baseSpeed(p) / 260, 0.75, 1.3);
    const behavior = behaviorOf(p);
    const tank = behavior === 'tank';
    const d: EnemyDef = {
      dex: p.dex,
      behavior,
      hp: Math.round(tier.hp * hpK * (tank ? 1.5 : 1)),
      speed: Math.round(tier.speed * spdK * (tank ? 0.7 : 1)),
      damage: Math.round(tier.damage * (tank ? 1.2 : 1)),
      xp: Math.max(3, Math.round(tier.xp * (tank ? 1.3 : 1))),
    };
    const cooldowns: Partial<Record<EnemyBehavior, number>> = {
      ranged: 2.2 - ti * 0.15,
      fan: 3.2 - ti * 0.15,
      beamer: 4.4 - ti * 0.2,
      zoner: 4.6 - ti * 0.2,
      healer: game.tuning.enemyHeals.cooldown,
      summoner: 7,
    };
    const cd = cooldowns[behavior];
    if (cd !== undefined) {
      d.shotDamage = Math.round(tier.damage * (behavior === 'fan' ? 0.7 : 0.8));
      d.shotCooldown = +cd.toFixed(2);
      d.range =
        (behavior === 'beamer'
          ? 260
          : behavior === 'healer' || behavior === 'summoner'
            ? 230
            : 190) +
        ti * 6;
    }
    if (behavior === 'summoner') {
      const minion = summons.get(p.dex);
      if (minion !== undefined) d.minion = minion;
    }
    if (behavior === 'fan') d.fanCount = ti < 2 ? 3 : 5;
    if (behavior === 'zoner') d.zones = ti < 2 ? 1 : ti < 4 ? 2 : 3;
    if (behavior === 'bomber') {
      d.speed = Math.round(d.speed * 1.25);
      d.hp = Math.round(d.hp * 0.8);
    }
    return d;
  };

  // original implementation rollRun() bosses (×1.35 HP and ×1.2 damage since 2026-10-10)
  const bossDef = (p: Pokemon, si: number): BossDef => {
    const slot = enemies.bossSlots[si];
    if (!slot) throw new Error(`no boss slot ${si}`);
    return {
      at: slot.at,
      dex: p.dex,
      hp: Math.round(slot.hp * 1.35),
      speed: Math.round(clamp(40 + baseSpeed(p) * 0.5, 40, 100)),
      damage: Math.round(slot.damage * 1.2),
      xp: slot.xp,
      behavior: behaviorOf(p) === 'ranged' ? 'ranged' : baseSpeed(p) > 90 ? 'charger' : 'chase',
      shotDamage: Math.round(slot.damage * 0.55),
      shotCooldown: 1.1,
      range: 260,
    };
  };

  const tierCandidates = enemies.tiers.map((tier) =>
    game.pokedex.filter(
      (p) => p.rarity < 5 && p.bst >= tier.bst[0] && p.bst <= tier.bst[1] && hasSprite(p.dex),
    ),
  );

  const { fromMinute, k: lateK } = enemies.lateGame;

  cached = {
    game,
    body(dex) {
      return (
        game.bodyByDex.get(dex) ?? {
          dex,
          radius: clamp(DEFAULT_BODY_WIDTH * 0.22, 5, 26) * 2,
          height: DEFAULT_BODY_ANCHOR * 2,
          hovers: false,
          shiny: false,
        }
      );
    },
    hasSprite,
    move,
    movePool(ts) {
      const ids = new Set(pool.get('normal'));
      for (const t of ts) for (const id of pool.get(t) ?? []) ids.add(id);
      return [...ids];
    },
    startingMove(dex) {
      const starter = game.starterByDex.get(dex);
      if (starter && moveById.has(starter.startingMove)) return starter.startingMove;
      const p = game.pokemonByDex.get(dex);
      for (const t of p?.types ?? []) {
        const id = movesFile.startingMoves[t];
        if (id) return id;
      }
      return 'tackle';
    },
    moveStats(id, level, evolved) {
      const m = move(id);
      const s: MoveStats = { ...m.stats };
      const ups = ladder(m);
      for (let i = 0; i < level - 1 && i < ups.length; i++) applyMods(s, ups[i]?.mods ?? {});
      const boost = movesFile.evolutionBoosts[m.kind];
      if (evolved && boost) applyMods(s, boost.mods);
      return s;
    },
    maxMoveLevel(id) {
      return ladder(move(id)).length + 1;
    },
    typeMult(attack, defender) {
      const row = attack ? types.chart[attack] : undefined;
      if (!row || defender.length === 0) return 1;
      let m = 1;
      for (const t of defender) {
        const g = row[t];
        if (g !== undefined) m *= soft[g] ?? 1;
      }
      return clamp(m, types.min, types.max);
    },
    perks(levels) {
      const L = (id: string) => upgradeLevel(upgrade(id), levels);
      const per = (id: string) => upgrade(id).perLevel;
      return {
        hp: L('max-hp') * per('max-hp'),
        attackMul: 1 + L('attack') * per('attack'),
        speedMul: 1 + L('speed') * per('speed'),
        cooldownMul: 1 - L('cooldown') * per('cooldown'),
        damageReduction: L('defense') * per('defense'),
        regen: L('regen') * per('regen'),
        magnetMul: 1 + L('magnet') * per('magnet'),
        xpMul: 1 + L('experience') * per('experience'),
        coinMul: 1 + L('coins') * per('coins'),
        startMoves: 1 + L('extra-move') * per('extra-move'),
        crit: L('crit') * per('crit'),
        rerolls: L('reroll') * per('reroll'),
        bans: L('ban') * per('ban'),
      };
    },
    item(id) {
      const it = game.itemById.get(id);
      if (!it) throw new Error(`unknown item ${id}`);
      return it;
    },
    statCard(id) {
      const c = game.statCardById.get(id);
      if (!c) throw new Error(`unknown stat card ${id}`);
      return c;
    },
    biomeLiquid,
    liquidEffect(liquid, ts) {
      const e = liquidOf(liquid);
      if (e.immune && ts.some((t) => e.immune?.includes(t))) return {};
      return e;
    },
    liquidHurts(liquid) {
      return !!liquidOf(liquid).damage;
    },
    prop(type) {
      const p = world.props[type as keyof typeof world.props];
      if (!p) throw new Error(`unknown prop ${type}`);
      return { solid: p.solid, hp: p.hp, r: p.radius, flat: p.flat };
    },
    behaviorOf,
    tierCandidates,
    enemyDef,
    bossDef,
    late(t) {
      const m = Math.max(0, t / 60 - fromMinute);
      return Math.exp(Math.min(30, lateK * m * m));
    },
  };
  return cached;
}
