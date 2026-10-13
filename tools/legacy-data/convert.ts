// One-off conversion of the legacy game data (legacy/js/data/*.js and the tuning tables in
// legacy/js/systems, world and entities) to the typed English JSON in packages/data/json.
//
//   pnpm --filter @pokesurvivor/tools convert-legacy-data [--only sprites.json,…]
//
// The generated JSON is maintained by hand afterwards, so this overwrites edits: use --only to
// rewrite just some files (e.g. the sprite manifest after the sprites change).
// Numbers are copied exactly as the legacy game computes them at load time. Display text goes
// through lang-en.js plus translations.ts; any text without a translation fails the run. Each
// file is validated against its schema before it's written. Item, level-up card and altar effects
// are re-derived from the legacy functions and checked against the declared effect data.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AchievementsFileSchema,
  BiomesFileSchema,
  EnemiesFileSchema,
  GachaFileSchema,
  ItemsFileSchema,
  LevelUpFileSchema,
  MissionsFileSchema,
  MovesFileSchema,
  MusicFileSchema,
  PokedexSchema,
  SpriteManifestSchema,
  StartersFileSchema,
  TuningFileSchema,
  TypeChartSchema,
  UpgradesFileSchema,
  WeatherFileSchema,
  WorldFileSchema,
  type AchievementMetric,
  type MoveStat,
  type StatEffect,
} from '@pokesurvivor/data/schemas';
import { format, resolveConfig } from 'prettier';
import type { z } from 'zod';
import { loadLegacy, repoRoot, type Legacy } from './legacy.js';
import { createTranslator } from './translate.js';
import {
  ACHIEVEMENT_IDS,
  ITEM_IDS,
  MISSION_IDS,
  MOVE_ID_RENAMES,
  POKEMON_NAME_FIXES,
  STAT_CARD_IDS,
  TRAITS,
  UPGRADE_IDS,
  slugify,
} from './translations.js';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

const outDir = resolve(repoRoot, 'packages/data/json');
const spritesDir = resolve(repoRoot, 'assets/pokemon');

const { G, dictionary, constant } = loadLegacy();
const tr = createTranslator(dictionary);
const writers: { file: string; write: () => Promise<void> }[] = [];
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1]?.split(',')) : undefined;

function fail(message: string): never {
  throw new Error(message);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
/** Map a legacy id through a rename table, failing on ids the table doesn't know. */
function rename(table: Record<string, string>, legacyId: string, what: string): string {
  return table[legacyId] ?? fail(`no new id for ${what} "${legacyId}"`);
}
const plain = (value: unknown): Legacy => JSON.parse(JSON.stringify(value));

/**
 * Queue a JSON file. `compact` writes one array entry per line (big tables that are easier to
 * read and diff that way; they're excluded from Prettier); otherwise Prettier formats it.
 */
function emit(file: string, schema: z.ZodType, data: unknown, compact?: { arrayKey?: string }) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) fail(`${file} doesn't match its schema:\n${parsed.error.message}`);
  writers.push({
    file,
    write: async () => {
      const path = join(outDir, file);
      let text: string;
      if (compact) {
        const lines = (rows: unknown[]) => rows.map((r) => '  ' + JSON.stringify(r)).join(',\n');
        if (compact.arrayKey) {
          const { [compact.arrayKey]: rows, ...rest } = data as Record<string, unknown[]>;
          const head = JSON.stringify(rest).slice(0, -1);
          text = `${head},"${compact.arrayKey}":[\n${lines(rows ?? [])}\n]}\n`;
        } else text = `[\n${lines(data as unknown[])}\n]\n`;
      } else
        text = await format(JSON.stringify(data), {
          ...(await resolveConfig(path)),
          parser: 'json',
        });
      writeFileSync(path, text);
      console.log(`wrote ${file}`);
    },
  });
}

const reward = (r: Record<string, number>) => {
  const out: { coins?: number; tickets?: number; tickets10?: number } = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'coins') out.coins = v;
    else if (k === 't1') out.tickets = v;
    else if (k === 't10') out.tickets10 = v;
    else fail(`unknown reward key ${k}`);
  }
  return out;
};

// ---------------------------------------------------------------- pokedex

const pokemonName = (p: Legacy): string => POKEMON_NAME_FIXES[p.dex] ?? p.name;
const pokedex = G.DEX.map((p: Legacy) => {
  const extra = Object.keys(p).filter(
    (k) =>
      ![
        'dex',
        'name',
        'types',
        'hp',
        'spd',
        'atk',
        'rarity',
        'bst',
        'starter',
        'gen',
        'leg',
      ].includes(k),
  );
  check(extra.length === 0, `pokedex ${p.dex}: unexpected fields ${extra.join()}`);
  const name = pokemonName(p);
  return {
    dex: p.dex,
    id: slugify(name),
    name,
    types: [...p.types],
    hp: p.hp,
    speed: p.spd,
    attack: p.atk,
    bst: p.bst,
    rarity: p.rarity,
    gen: p.gen,
    starter: p.starter,
    legendary: p.leg === true,
  };
});
emit('pokedex.json', PokedexSchema, pokedex, {});
const nameOfDex = new Map<number, string>(pokedex.map((p: Legacy) => [p.dex, p.name]));

// ---------------------------------------------------------------- sprites

function hashDir(dir: string): string {
  const hash = createHash('sha1');
  const visit = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) visit(join(d, entry.name), `${rel}${entry.name}/`);
      else {
        hash.update(rel + entry.name + '\0');
        hash.update(readFileSync(join(d, entry.name)));
      }
    }
  };
  visit(dir, '');
  return hash.digest('hex').slice(0, 8);
}

const anim = (a: Legacy) => {
  const extra = Object.keys(a).filter((k) => !['w', 'h', 'n', 'r', 'd', 'ax', 'ay'].includes(k));
  check(extra.length === 0, `sprite anim: unexpected fields ${extra.join()}`);
  return {
    width: a.w,
    height: a.h,
    frames: a.n,
    rows: a.r,
    durations: [...a.d],
    anchorX: a.ax,
    anchorY: a.ay,
  };
};
const mapAnims = (anims: Record<string, Legacy>) =>
  Object.fromEntries(Object.entries(anims).map(([name, a]) => [name, anim(a)]));

const spriteDexes = Object.keys(G.SPRITE_META)
  .map(Number)
  .sort((a, b) => a - b);
const sprites = {
  basePath: '/sprites',
  pokemon: spriteDexes.map((dex) => {
    const m = G.SPRITE_META[dex];
    const extra = Object.keys(m).filter((k) => !['s', 'a', 'sh', 'hv', 'sa'].includes(k));
    check(extra.length === 0, `sprite meta ${dex}: unexpected fields ${extra.join()}`);
    return {
      dex,
      hash: hashDir(join(spritesDir, String(dex))),
      shadowSize: m.s,
      hovers: m.hv === 1,
      shiny: m.sh === 1,
      animations: mapAnims(m.a),
      ...(m.sa ? { shinyAnimations: mapAnims(m.sa) } : {}),
    };
  }),
};
emit('sprites.json', SpriteManifestSchema, sprites, { arrayKey: 'pokemon' });

// ---------------------------------------------------------------- types

const TYPE_IDS = Object.keys(G.U.TYPE_NAME);
const typeName = (t: string): string => tr(G.U.TYPE_NAME[t]);
const soft = constant('data/types.js', 'SOFT');
emit('types.json', TypeChartSchema, {
  types: TYPE_IDS.map((id) => ({ id, name: typeName(id), color: G.U.TYPE_COLOR[id] })),
  chart: plain(G.Types.CHART),
  softened: { superEffective: soft[2], notVeryEffective: soft[0.5], immune: soft[0] },
  min: constant('data/types.js', 'MIN'),
  max: constant('data/types.js', 'MAX'),
});

// ---------------------------------------------------------------- level-up cards

const STAT_RENAMES: Record<string, string> = {
  atkMul: 'attackMul',
  spdMul: 'speedMul',
  cdMul: 'cooldownMul',
  xpMul: 'xpMul',
  coinMul: 'coinMul',
  magnet: 'magnet',
  dmgReduce: 'damageReduction',
  regenFlat: 'regen',
};
const LEGACY_STAT = Object.fromEntries(Object.entries(STAT_RENAMES).map(([a, b]) => [b, a]));
const LEGACY_STAT_FIELDS = STAT_RENAMES;

/** A legacy player with just the fields effects touch. */
function mockPlayer(): Legacy {
  return {
    atkMul: 1.25,
    spdMul: 1.1,
    cdMul: 0.9,
    xpMul: 1.05,
    coinMul: 1.2,
    magnet: 78,
    dmgReduce: 0.1,
    regenFlat: 0.4,
    maxHp: 137,
    hp: 90,
    addMaxHp(v: number) {
      this.maxHp += v;
      this.hp += v;
    },
    heal(v: number) {
      this.hp = Math.min(this.maxHp, this.hp + v);
    },
  };
}
function applyStatEffect(p: Legacy, e: StatEffect) {
  const key = LEGACY_STAT[e.stat] ?? fail(`no legacy stat for ${e.stat}`);
  const value = e.perMaxHp ? p.maxHp * e.value : e.value;
  let next = e.op === 'mul' ? p[key] * value : p[key] + value;
  if (e.cap !== undefined) next = Math.min(e.cap, next);
  p[key] = next;
}
/** Checks that `legacy(player)` does exactly what `ours(player)` does. */
function sameEffect(
  what: string,
  legacy: (p: Legacy) => void,
  ours: (p: Legacy) => void,
  tolerance = 0,
) {
  const a = mockPlayer();
  const b = mockPlayer();
  legacy(a);
  ours(b);
  // Private bookkeeping fields (e.g. `_itemRegen`, used to undo Leftovers) don't count.
  for (const k of [...Object.keys(LEGACY_STAT_FIELDS), 'maxHp', 'hp']) {
    check(
      tolerance ? Math.abs(a[k] - b[k]) <= tolerance : Object.is(a[k], b[k]),
      `${what}: ${k} is ${a[k]} in legacy but ${b[k]} from data`,
    );
  }
}

type CardEffect =
  | ({ type: 'stat' } & StatEffect)
  | { type: 'maxHp'; value: number }
  | { type: 'heal'; maxHpFraction: number };
const STAT_CARD_EFFECTS: Record<string, CardEffect> = {
  hp: { type: 'maxHp', value: 20 },
  atk: { type: 'stat', stat: 'attackMul', op: 'mul', value: 1.1 },
  spd: { type: 'stat', stat: 'speedMul', op: 'mul', value: 1.07 },
  cd: { type: 'stat', stat: 'cooldownMul', op: 'mul', value: 0.92 },
  def: { type: 'stat', stat: 'damageReduction', op: 'add', value: 0.06, cap: 0.7 },
  rgn: { type: 'stat', stat: 'regen', op: 'add', value: 0.9 },
  mag: { type: 'stat', stat: 'magnet', op: 'mul', value: 1.3 },
  xp: { type: 'stat', stat: 'xpMul', op: 'mul', value: 1.12 },
  heal: { type: 'heal', maxHpFraction: 0.45 },
};
function applyCardEffect(p: Legacy, e: CardEffect) {
  if (e.type === 'maxHp') p.addMaxHp(e.value);
  else if (e.type === 'heal') p.heal(p.maxHp * e.maxHpFraction);
  else {
    applyStatEffect(p, e);
  }
}

const levelUpStats = constant('systems/levelup.js', 'STATS');
const statCards = levelUpStats.map((s: Legacy) => {
  const effect = STAT_CARD_EFFECTS[s.id] ?? fail(`no effect for level-up card ${s.id}`);
  sameEffect(`level-up card ${s.id}`, s.apply, (p) => applyCardEffect(p, effect));
  return {
    id: rename(STAT_CARD_IDS, s.id, 'level-up card'),
    icon: s.icon,
    name: tr(s.title),
    description: tr(s.desc),
    ...(s.max ? { maxPicks: s.max } : {}),
    effect,
  };
});
emit('levelup.json', LevelUpFileSchema, {
  // From systems/levelup.js candidates()/offer() and entities/player.js.
  cardsOffered: 3,
  newMoveCandidates: 6,
  statCandidates: 5,
  maxBuffMoves: 2,
  maxMoveSlots: 4,
  weights: {
    newMove: 10,
    evolution: 40,
    moveUpgrade: 8,
    statForEvolution: 14,
    statWithFreeSlots: 4,
    stat: 7,
  },
  statCards,
});

// ---------------------------------------------------------------- moves

const MOVE_STAT_RENAMES: Record<string, MoveStat> = {
  cd: 'cooldown',
  dmg: 'damage',
  radius: 'radius',
  arc: 'arc',
  width: 'width',
  knock: 'knockback',
  speed: 'speed',
  count: 'count',
  spread: 'spread',
  pierce: 'pierce',
  life: 'lifetime',
  size: 'size',
  homing: 'homing',
  burn: 'burn',
  poison: 'poison',
  slow: 'slow',
  amount: 'amount',
  dur: 'duration',
  stacks: 'stacks',
  rate: 'rate',
  range: 'range',
  hex: 'hexBonus',
};
const moveStat = (k: string): MoveStat => MOVE_STAT_RENAMES[k] ?? fail(`unknown move stat ${k}`);
const mods = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [moveStat(k), v]));
const BUFF_STATS: Record<string, 'attack' | 'speed' | 'defense' | 'regen'> = {
  atk: 'attack',
  spd: 'speed',
  def: 'defense',
  regen: 'regen',
};
const moveId = (legacyId: string) => MOVE_ID_RENAMES[legacyId] ?? legacyId;
const statCardIdOf = (legacyId: string) => rename(STAT_CARD_IDS, legacyId, 'level-up card');

const ladders = constant('data/moves.js', 'LADDERS');
const evoMods = constant('data/moves.js', 'EVO_MODS');
const needName = G.Moves.NEED_NAME;
for (const [need, name] of Object.entries(needName)) {
  // The legacy evolution conditions are named after the level-up cards.
  const card = levelUpStats.find((s: Legacy) => s.id === need);
  check(card?.title === name, `evolution condition ${need} isn't level-up card "${String(name)}"`);
}
const moves = G.Moves.ALL.map((m: Legacy) => {
  const stats: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    if (['id', 'name', 'type', 'kind', 'desc', 'stat', 'ups', 'maxLvl'].includes(k)) continue;
    check(typeof v === 'number', `move ${m.id}.${k} is not a number`);
    stats[moveStat(k)] = v;
  }
  const evo = G.Moves.EVO[m.id];
  const evoName = evo ? tr(evo[0]) : undefined;
  return {
    id: moveId(m.id),
    name: tr(m.name),
    type: m.type,
    kind: m.kind,
    description: tr(m.desc),
    stats,
    ...(m.stat ? { buffStat: BUFF_STATS[m.stat] ?? fail(`unknown buff stat ${m.stat}`) } : {}),
    ...(evo
      ? { evolution: { id: slugify(evoName!), name: evoName!, requires: statCardIdOf(evo[1]) } }
      : {}),
  };
});
check(
  Object.keys(G.Moves.EVO).every((id) => G.Moves.BY_ID[id]),
  'evolution for an unknown move',
);
emit('moves.json', MovesFileSchema, {
  modifierRules: {
    multiplicative: constant('data/moves.js', 'MULT').map(moveStat),
    additive: constant('data/moves.js', 'ADD').map(moveStat),
  },
  upgradeLadders: Object.fromEntries(
    Object.entries(ladders).map(([kind, steps]) => [
      kind,
      (steps as Legacy[]).map((s) => ({ text: tr(s.t), mods: mods(s.m) })),
    ]),
  ),
  evolutionBoosts: Object.fromEntries(
    Object.entries(evoMods).map(([kind, e]: [string, Legacy]) => [
      kind,
      { text: tr(e.t), mods: mods(e.m) },
    ]),
  ),
  startingMoves: Object.fromEntries(
    Object.entries(constant('data/moves.js', 'START')).map(([t, id]) => [t, moveId(id as string)]),
  ),
  moves,
});

// ---------------------------------------------------------------- starters

const traitId = (es: string) => TRAITS[es]?.id ?? fail(`unknown trait ${es}`);
emit('starters.json', StartersFileSchema, {
  traits: Object.entries(G.TRAIT_TEXT).map(([es, text]) => ({
    id: traitId(es),
    name: TRAITS[es]!.name,
    description: tr(text as string),
  })),
  starters: G.STARTERS.map((s: Legacy) => ({
    dex: s.dex,
    startingMove: moveId(s.start),
    traits: s.traits.map(traitId),
  })),
  personalityTest: G.PERSONALITY_TEST.map((q: Legacy) => ({
    question: tr(q.q),
    answers: q.a.map((a: Legacy) => ({
      text: tr(a.t),
      points: Object.fromEntries(Object.entries(a.p).map(([t, n]) => [traitId(t), n])),
    })),
  })),
});

// ---------------------------------------------------------------- enemies

const set = (name: string) => [...(constant('data/enemies.js', name) as Set<number>)];
emit('enemies.json', EnemiesFileSchema, {
  tiers: G.Enemies.TIERS.map((t: Legacy) => ({
    from: t.from,
    bst: [...t.bst],
    hp: t.hp,
    speed: t.spd,
    damage: t.dmg,
    xp: t.xp,
    castSize: t.cast,
  })),
  bossSlots: G.Enemies.BOSS_SLOTS.map((b: Legacy) => ({
    at: b.at,
    hp: b.hp,
    damage: b.dmg,
    xp: b.xp,
    bst: [...b.bst],
  })),
  lateGame: { fromMinute: G.Enemies.LATE_FROM, k: constant('data/enemies.js', 'LATE_K') },
  fixedBehaviors: { healer: set('HEAL'), shielder: set('SHIELD'), bomber: set('BOMB') },
  summons: Object.entries(constant('data/enemies.js', 'SUMMON')).map(([summoner, minion]) => ({
    summoner: Number(summoner),
    minion: minion as number,
  })),
});

// ---------------------------------------------------------------- upgrades

const UPGRADE_PER_LEVEL: Record<string, number> = {
  hp: 8,
  atk: 0.04,
  spd: 0.03,
  cd: 0.03,
  def: 0.02,
  regen: 0.2,
  magnet: 0.12,
  xp: 0.05,
  coins: 0.08,
  moves: 1,
  crit: 0.03,
  reroll: 1,
  ban: 1,
};
// perks() key and how the level combines into it, to check UPGRADE_PER_LEVEL against the code.
const PERKS: Record<string, [string, (level: number, per: number) => number]> = {
  hp: ['hp', (l, k) => l * k],
  atk: ['atkMul', (l, k) => 1 + l * k],
  spd: ['spdMul', (l, k) => 1 + l * k],
  cd: ['cdMul', (l, k) => 1 - l * k],
  def: ['dmgReduce', (l, k) => l * k],
  regen: ['regen', (l, k) => l * k],
  magnet: ['magnetMul', (l, k) => 1 + l * k],
  xp: ['xpMul', (l, k) => 1 + l * k],
  coins: ['coinMul', (l, k) => 1 + l * k],
  moves: ['startMoves', (l, k) => 1 + l * k],
  crit: ['crit', (l, k) => l * k],
  reroll: ['rerolls', (l, k) => l * k],
  ban: ['bans', (l, k) => l * k],
};
const upgrades = G.Upgrades.LIST.map((u: Legacy) => {
  const per = UPGRADE_PER_LEVEL[u.id] ?? fail(`no perLevel for upgrade ${u.id}`);
  const [key, formula] = PERKS[u.id]!;
  for (let level = 0; level <= u.max; level++) {
    const got = G.Upgrades.perks({ [u.id]: level })[key];
    check(
      Object.is(got, formula(level, per)),
      `upgrade ${u.id} level ${level}: perks() gives ${got}`,
    );
  }
  return {
    id: rename(UPGRADE_IDS, u.id, 'upgrade'),
    icon: u.icon,
    name: tr(u.name),
    description: tr(u.unit),
    maxLevel: u.max,
    baseCost: u.base,
    costGrowth: u.grow,
    perLevel: per,
  };
});
emit('upgrades.json', UpgradesFileSchema, upgrades);

// ---------------------------------------------------------------- items

const ITEM_EFFECTS: Record<string, { effects: StatEffect[]; params?: Record<string, number> }> = {
  leftovers: { effects: [{ stat: 'regen', op: 'add', value: 0.015, perMaxHp: true }] },
  choiceband: { effects: [{ stat: 'attackMul', op: 'mul', value: 1.4 }] },
  quickclaw: { effects: [{ stat: 'cooldownMul', op: 'mul', value: 0.8 }] },
  // entities/player.js hurt(): survive at 1 HP once per cooldown, then briefly invulnerable.
  focussash: { effects: [], params: { cooldownSeconds: 60, invulnerableSeconds: 1.2 } },
  // entities/player.js onDealt(): bank `healPerDamage` × damage dealt, up to `maxBankedHeal`.
  shellbell: { effects: [], params: { healPerDamage: 0.04, maxBankedHeal: 4 } },
  amuletcoin: { effects: [{ stat: 'coinMul', op: 'mul', value: 1.5 }] },
  luckyegg: { effects: [{ stat: 'xpMul', op: 'mul', value: 1.3 }] },
  // entities/player.js cast(): each cast (not orbit/trail) costs max(minHpCost, fraction × max HP).
  lifeorb: {
    effects: [{ stat: 'attackMul', op: 'mul', value: 1.3 }],
    params: { hpCostPerCast: 0.01, minHpCost: 1 },
  },
  choicescarf: { effects: [{ stat: 'speedMul', op: 'mul', value: 1.35 }] },
  // systems/combat.js: melee attackers take damageBase + damagePerLevel × player level.
  rockyhelmet: { effects: [], params: { damageBase: 15, damagePerLevel: 4, knockback: 80 } },
  assaultvest: { effects: [{ stat: 'damageReduction', op: 'add', value: 0.2 }] },
};
const items = G.Items.LIST.map((it: Legacy) => {
  const def = ITEM_EFFECTS[it.id] ?? fail(`no effects for item ${it.id}`);
  sameEffect(`item ${it.id}`, it.on, (p) => def.effects.forEach((e) => applyStatEffect(p, e)));
  sameEffect(
    `item ${it.id} on+off`,
    (p) => {
      it.on(p);
      it.off(p);
    },
    () => {},
    1e-12,
  );
  return {
    id: rename(ITEM_IDS, it.id, 'item'),
    name: tr(it.name),
    description: tr(it.desc),
    effects: def.effects,
    ...(def.params ? { params: def.params } : {}),
  };
});
emit('items.json', ItemsFileSchema, items);

// ---------------------------------------------------------------- missions

const EVENTS: Record<string, string> = {
  kill: 'defeat',
  chest: 'chest',
  item: 'item',
  evolve: 'evolve',
  rift: 'rift-win',
  runEnd: 'run-end',
  missionDone: 'mission-done',
};
/** Recognise the legacy match/value functions by behaviour on probe events. */
function missionFilter(match: Legacy): 'boss' | 'daily' | 'has-type' | undefined {
  if (!match) return undefined;
  if (match({ boss: true, types: [] }, 'fire') && !match({ boss: false, types: [] }, 'fire'))
    return 'boss';
  if (match({ daily: true, types: [] }) && !match({ daily: false, types: [] })) return 'daily';
  if (match({ types: ['fire'] }, 'fire') && !match({ types: ['water'] }, 'fire')) return 'has-type';
  return fail(`unrecognised mission filter ${String(match)}`);
}
function missionValue(value: Legacy): 'minutes' | 'level' | 'coins' | undefined {
  if (!value) return undefined;
  if (value({ time: 600 }) === 10 && value({ time: 659 }) === 10) return 'minutes';
  if (value({ level: 7 }) === 7) return 'level';
  if (value({ coins: 7 }) === 7) return 'coins';
  return fail(`unrecognised mission value ${String(value)}`);
}
const PLACEHOLDER_TYPE = '__type__';
G.U.TYPE_NAME[PLACEHOLDER_TYPE] = '{x}';
const mission = (m: Legacy) => {
  // Render the legacy text function with placeholders, translate it as a pattern, then name them.
  const spanish = m.text('{x}', PLACEHOLDER_TYPE) as string;
  const names = [...spanish.matchAll(/\{x\}/g)].map((_, i) =>
    i === 0
      ? '{count}'
      : m.param === 'type'
        ? '{type}'
        : fail(`mission ${m.id}: extra placeholder`),
  );
  const english = tr(spanish);
  let i = 0;
  const text = english.replace(/\{x\}/g, () => names[i++] ?? fail(`mission ${m.id}: placeholders`));
  check(i === names.length, `mission ${m.id}: lost a placeholder in "${english}"`);
  const singular = m.goals.includes(1) ? (m.text(1, PLACEHOLDER_TYPE) as string) : undefined;
  return {
    id: rename(MISSION_IDS, m.id, 'mission'),
    event: EVENTS[m.ev] ?? fail(`unknown mission event ${m.ev}`),
    ...(m.match ? { filter: missionFilter(m.match) } : {}),
    ...(m.value ? { value: missionValue(m.value) } : {}),
    mode: m.mode ?? 'add',
    ...(m.param ? { param: m.param } : {}),
    goals: [...m.goals],
    reward: reward(m.reward),
    text,
    ...(singular && !/\d/.test(singular) && tr(singular) !== text
      ? { textSingular: tr(singular) }
      : {}),
  };
};
check(
  G.MissionDefs.weekly.every(
    (m: Legacy) => m.param !== 'type' && !m.text(1, PLACEHOLDER_TYPE).includes('{x}'),
  ),
  'weekly mission text',
);
emit('missions.json', MissionsFileSchema, {
  // systems/progress.js ensure().
  dailyCount: 3,
  weeklyCount: 2,
  daily: G.MissionDefs.daily.map(mission),
  weekly: G.MissionDefs.weekly.map(mission),
});
delete G.U.TYPE_NAME[PLACEHOLDER_TYPE];

// ---------------------------------------------------------------- achievements

const CATEGORY_IDS: Record<string, string> = {
  coleccion: 'collection',
  supervivencia: 'survival',
  combate: 'combat',
  grietas: 'rifts',
  legendarios: 'legendaries',
  otros: 'other',
};
const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, 1]));
/** A save on which the metric reads 7 (and every other metric 0). */
const PROBES: Record<Exclude<AchievementMetric, 'legendary-defeated'>, Legacy> = {
  'pokemon-owned': { owned: keys(7) },
  'shinies-owned': { shiny: keys(7) },
  'legendaries-defeated': { legends: keys(7) },
  'gacha-pulls': { stats: { pulls: 7 } },
  'best-time-minutes': { stats: { bestTime: 7 * 60 + 59 } },
  'best-level': { stats: { bestLevel: 7 } },
  runs: { stats: { runs: 7 } },
  'total-defeated': { stats: { totalKills: 7 } },
  'bosses-defeated': { stats: { bossesTotal: 7 } },
  'move-evolutions': { stats: { evolutions: 7 } },
  'distinct-moves-evolved': { evoMoves: keys(7) },
  'distinct-items-found': { itemsFound: keys(7) },
  'rift-wins': { stats: { riftWins: 7 } },
  'arenas-won': { arenas: keys(7) },
  'missions-done': { stats: { missionsDone: 7 } },
  'group-runs': { stats: { groupRuns: 7 } },
};
function achievementMetric(a: Legacy): AchievementMetric {
  if (a.dex) {
    check(a.value({ legends: { [a.dex]: 1 } }) === 1 && a.value({}) === 0, `achievement ${a.id}`);
    return 'legendary-defeated';
  }
  const hits = Object.entries(PROBES).filter(([, save]) => a.value(save) === 7);
  check(hits.length === 1 && a.value({}) === 0, `achievement ${a.id}: metric is ambiguous`);
  return hits[0]![0] as AchievementMetric;
}
emit('achievements.json', AchievementsFileSchema, {
  categories: G.AchDefs.CATS.map(([id, name]: [string, string]) => ({
    id: rename(CATEGORY_IDS, id, 'achievement category'),
    name: tr(name),
  })),
  achievements: G.AchDefs.LIST.map((a: Legacy) => {
    let id: string;
    let name: string;
    let description: string;
    if (a.dex) {
      const mon = nameOfDex.get(a.dex) ?? fail(`achievement ${a.id}: unknown dex`);
      id = `defeat-${slugify(mon)}`;
      // The legacy texts embed the (sometimes Spanish) legacy name: translate with the English one.
      name = tr(a.name.replace(G.DEX_BY[a.dex].name, mon));
      description = tr(a.desc.replace(G.DEX_BY[a.dex].name, mon));
    } else {
      id = rename(ACHIEVEMENT_IDS, a.id, 'achievement');
      name = tr(a.name);
      description = tr(a.desc);
    }
    return {
      id,
      category: rename(CATEGORY_IDS, a.cat, 'achievement category'),
      tier: a.tier,
      name,
      description,
      metric: achievementMetric(a),
      goal: a.goal,
      reward: reward(a.reward),
      ...(a.title ? { title: tr(a.title) } : {}),
      ...(a.dex ? { dex: a.dex } : {}),
    };
  }),
});

// ---------------------------------------------------------------- music

const music = Object.fromEntries(
  Object.entries(G.MUSIC).map(([id, t]: [string, Legacy]) => [
    id,
    {
      bpm: t.bpm,
      ...(t.swing !== undefined ? { swing: t.swing } : {}),
      chords: [...t.chords],
      melody: t.melody.map((m: Legacy) => ({
        instrument: m.inst,
        velocity: m.vel,
        bars: [...m.bars],
      })),
      parts: t.parts.map((p: Legacy) => ({
        instrument: p.inst,
        octave: p.octave,
        velocity: p.vel,
        pattern: p.pattern,
        ...(p.useBass ? { useBass: true } : {}),
      })),
      drums: plain(t.drums),
    },
  ]),
);
emit('music.json', MusicFileSchema, music);

// ---------------------------------------------------------------- gacha

const BANNER_IDS = [
  'kanto',
  'johto',
  'hoenn',
  'sinnoh',
  'unova',
  'kalos',
  'alola',
  'galar',
  'paldea',
];
const gacha = (name: string) => constant('systems/gacha.js', name);
const gachaRates = gacha('RATES') as [number, number][];
emit('gacha.json', GachaFileSchema, {
  // systems/gacha.js costOf().
  cost: { single: 1, multi: 10, multiCount: 10, multiTickets10: 1 },
  rates: gachaRates.map(([rarity, weight]) => ({ rarity, weight })),
  hardPity: gacha('PITY_5'),
  multiGuaranteeMinRarity: 4,
  shinyRate: gacha('SHINY_RATE'),
  duplicateRefund: Object.entries(gacha('REFUND')).map(([rarity, coins]) => ({
    rarity: Number(rarity),
    coins: coins as number,
  })),
  shinyDuplicateMultiplier: 3,
  rarities: Object.entries(gacha('RARITY_NAME')).map(([rarity, name]) => ({
    rarity: Number(rarity),
    name: tr(name as string),
    color: gacha('RARITY_COLOR')[rarity],
  })),
  banners: gacha('BANNERS').map((b: Legacy) => ({
    id: BANNER_IDS[b.gen - 1] ?? fail(`banner gen ${b.gen}`),
    gen: b.gen,
    name: tr(b.name),
    colors: [...b.color],
  })),
});

// ---------------------------------------------------------------- biomes, world, weather

const RUN_BIOME_IDS = ['shady-forest', 'crystal-cave', 'ash-volcano'];
const tilesBiomes = constant('world/tiles.js', 'BIOMES');
const arenaThemes = constant('world/tiles.js', 'ARENA_THEMES');
emit('biomes.json', BiomesFileSchema, {
  runBiomes: tilesBiomes.map((b: Legacy, i: number) => {
    const { name, liquid, prop, liq, liqDeep, ...palette } = b;
    return {
      id: RUN_BIOME_IDS[i] ?? fail(`run biome ${i}`),
      name: tr(name),
      liquid,
      prop,
      music: G.BIOME_MUSIC[i] ?? fail(`no music for biome ${i}`),
      palette: { ...plain(palette), liquid: liq, liquidDeep: liqDeep },
    };
  }),
  arenas: Object.entries(arenaThemes).map(([type, a]: [string, Legacy]) => {
    const { name, liquid, prop, pools, pillars, props, weather, liq, ...palette } = a;
    return {
      type,
      name: tr(name),
      liquid,
      prop,
      pools,
      pillars,
      props: plain(props),
      weather,
      palette: { ...plain(palette), liquid: liq },
    };
  }),
});

const PROP_IDS: Record<string, string> = { bigchest: 'big-chest' };
const POWER_IDS: Record<string, [string, string]> = {
  // "Rayo" is also Thunderbolt's Spanish name, so these don't go through the dictionary.
  dmg: ['fury', 'Fury'],
  spd: ['lightning', 'Lightning'],
  mag: ['magnet', 'Magnet'],
  cd: ['haste', 'Haste'],
};
const POWER_EFFECTS: Record<
  string,
  { stat: 'attackMul' | 'speedMul' | 'cooldownMul' | 'magnet'; value: number }
> = {
  dmg: { stat: 'attackMul', value: 2 },
  spd: { stat: 'speedMul', value: 1.45 },
  mag: { stat: 'magnet', value: 4 },
  cd: { stat: 'cooldownMul', value: 0.6 },
};
const liquids = constant('world/world.js', 'LIQ');
emit('world.json', WorldFileSchema, {
  props: Object.fromEntries(
    Object.entries(constant('world/world.js', 'PROP')).map(([type, p]: [string, Legacy]) => [
      PROP_IDS[type] ?? type,
      { solid: p.solid, hp: p.hp === Infinity ? null : p.hp, radius: p.r, flat: p.flat === true },
    ]),
  ),
  liquids: Object.fromEntries(
    Object.entries(liquids).map(([id, l]: [string, Legacy]) => {
      const { dmg, ...rest } = l;
      return [id, { ...plain(rest), ...(dmg !== undefined ? { damage: dmg } : {}) }];
    }),
  ),
  bigChestOpenSeconds: constant('systems/interact.js', 'CHEST_TIME'),
  trapRadius: constant('systems/interact.js', 'TRAP_R'),
  altarPowerSeconds: constant('systems/interact.js', 'POWER_TIME'),
  altarPowers: constant('systems/interact.js', 'POWERS').map((pw: Legacy) => {
    const [id, name] = POWER_IDS[pw.id] ?? fail(`altar power ${pw.id}`);
    const effect = { ...POWER_EFFECTS[pw.id]!, op: 'mul' as const };
    sameEffect(`altar power ${pw.id}`, pw.on, (p) => applyStatEffect(p, effect));
    return { id, name, description: tr(pw.desc), color: pw.color, effect };
  }),
});

const weatherKinds = constant('systems/weather.js', 'KINDS');
emit('weather.json', WeatherFileSchema, {
  kinds: Object.entries(weatherKinds).map(([id, k]: [string, Legacy]) => ({
    id,
    name: tr(k.name),
    hint: tr(k.hint),
    icon: k.icon,
    color: k.color,
    tint: [...k.tint],
    multipliers: plain(k.mult),
    ...(k.safe ? { immuneTypes: [...k.safe] } : {}),
    slows: k.slow === true,
  })),
  biomeWeights: plain(constant('systems/weather.js', 'BIOME_W')),
  startAfter: constant('systems/weather.js', 'FROM'),
  checkEvery: constant('systems/weather.js', 'CHECK'),
  chance: constant('systems/weather.js', 'CHANCE'),
  // systems/weather.js update(): round(rand(55, 75)).
  durationRange: [55, 75],
});

// ---------------------------------------------------------------- tuning

emit('tuning.json', TuningFileSchema, {
  spawner: {
    cap: constant('systems/spawner.js', 'CAP'),
    eliteFrom: constant('systems/spawner.js', 'ELITE_FROM'),
    density: constant('systems/spawner.js', 'DENSITY'),
    damageK: constant('systems/spawner.js', 'DMG_K'),
    xpK: constant('systems/spawner.js', 'XP_K'),
    shinyRate: constant('systems/spawner.js', 'SHINY_RATE'),
  },
  rift: {
    checkEvery: constant('systems/rift.js', 'CHECK'),
    chance: constant('systems/rift.js', 'CHANCE'),
    startAfter: constant('systems/rift.js', 'FROM'),
    ttl: constant('systems/rift.js', 'TTL'),
    arenaRadius: constant('systems/rift.js', 'ARENA_R'),
    arenaTime: constant('systems/rift.js', 'ARENA_TIME'),
  },
  events: {
    every: [...constant('systems/events.js', 'EVERY')],
    duration: constant('systems/events.js', 'DUR'),
    lostTime: constant('systems/events.js', 'LOST_TIME'),
    thiefFirst: [...constant('systems/events.js', 'THIEF_FIRST')],
    thiefNext: [...constant('systems/events.js', 'THIEF_NEXT')],
    thiefLife: constant('systems/events.js', 'THIEF_LIFE'),
  },
  combat: { critMultiplier: constant('systems/combat.js', 'CRIT_MUL') },
  pickups: {
    max: constant('entities/pickup.js', 'MAX'),
    ticketDropRate: constant('entities/pickup.js', 'TICKET_RATE'),
    bossTicket10Chance: constant('entities/pickup.js', 'BOSS_T10'),
    legendaryTicket10Chance: constant('entities/pickup.js', 'LEGEND_T10'),
  },
});

// ---------------------------------------------------------------- id map, write

if (tr.missing.size) {
  fail(
    `${tr.missing.size} text(s) have no English translation; add them to translations.ts:\n` +
      [...tr.missing].map((s) => `  ${JSON.stringify(s)}: '',`).join('\n'),
  );
}

// Legacy → new ids, for porting legacy code and checking parity against it.
const legacyIds = {
  moves: MOVE_ID_RENAMES,
  items: ITEM_IDS,
  upgrades: UPGRADE_IDS,
  levelUpCards: STAT_CARD_IDS,
  missions: MISSION_IDS,
  achievements: ACHIEVEMENT_IDS,
  achievementCategories: CATEGORY_IDS,
  traits: Object.fromEntries(Object.entries(TRAITS).map(([es, t]) => [es, t.id])),
  altarPowers: Object.fromEntries(Object.entries(POWER_IDS).map(([k, [id]]) => [k, id])),
  props: PROP_IDS,
  progressEvents: EVENTS,
};
writers.push({
  file: 'legacy-ids.json',
  write: async () => {
    const path = resolve(import.meta.dirname, 'legacy-ids.json');
    writeFileSync(
      path,
      await format(JSON.stringify(legacyIds), { ...(await resolveConfig(path)), parser: 'json' }),
    );
    console.log('wrote tools/legacy-data/legacy-ids.json');
  },
});
// lang-en.js keys consumed by data, read by seed-ui-strings.ts.
writers.push({
  file: 'data-dictionary-keys.json',
  write: async () => {
    const path = resolve(import.meta.dirname, 'data-dictionary-keys.json');
    writeFileSync(
      path,
      await format(JSON.stringify([...tr.used].sort()), {
        ...(await resolveConfig(path)),
        parser: 'json',
      }),
    );
  },
});

if (only) {
  const unknownFiles = [...only].filter((f) => !writers.some((w) => w.file === f));
  check(unknownFiles.length === 0, `--only: unknown file(s) ${unknownFiles.join(', ')}`);
}
for (const { file, write } of writers) if (!only || only.has(file)) await write();
