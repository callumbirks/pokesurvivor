// Manual check of runaway late-game scaling (v14 playtest: a fully upgraded solo Pokémon standing
// still from minute 11, clearing everything). Never runs in CI.
//   pnpm --filter @pokesurvivor/sim runaway --variant=v14 --out=v14.jsonl
//   pnpm --filter @pokesurvivor/sim runaway --variant=v13 --out=v13.jsonl
//   pnpm --filter @pokesurvivor/sim runaway --variant=v14 --fix=power-cap-10 --out=fix.jsonl
//   (--friend-atk= / --friend-regen=: the minute-14 reconstruction with another ATK × or regen)
// `v13` puts back what v14 changed in the shared data: v13's stat cards (old values, the pick
// limits as ceilings, no rarities) and wild damage (damageK 4.8, forward arrivals 0.15, no forward
// catch-up). `--fix` applies one candidate fix on top (see FIXES).
//
// Per cell, a protected run with a greedy human-like card policy (evolutions, then the best stat
// card by rarity × preference, then move upgrades). At each minute it records:
// - the attack multiplier split into species base, upgrades, item, buffs, Momentum and cards,
//   with the Power picks' rarities;
// - cooldown, regen, damage reduction, max HP, level and picks per card;
// - the live regular wild Pokémon's HP and raw contact damage, and that contact after defence;
// - potential single-target DPS on a pinned dummy (30 s) and the regular TTK it implies;
// - three 30 s stand-still probes from a copy of the run (real crowd, not protected): as is,
//   with attack ÷100 (defence alone), and without regen and card/item damage reduction
//   (offence alone). Each records incoming DPS, healing, downs, contacts and kills.
import { appendFileSync, writeFileSync } from 'node:fs';
import { DT } from '../src/constants.js';
import { simData } from '../src/data.js';
import { restoreSim, type PlayerState, type Sim } from '../src/index.js';
import { BOND_MAX } from '../src/bonds.js';
import { momentumMultiplier } from '../src/momentum.js';
import { evolveMove, newMove } from '../src/moves.js';
import { attackOf, reductionOf, regenOf } from '../src/players.js';
import { enemyScale } from '../src/spawner.js';
import type { SimState } from '../src/state.js';
import { resetChunks } from '../src/world.js';
import { spawnDummy } from './helpers.js';
import {
  archetypes,
  drive,
  loadBuild,
  makeSim,
  selectAttackSlot,
  type Cell,
} from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
const list = (key: string, fallback: string) => (args.get(key) ?? fallback).split(',');
const variant = args.get('variant') ?? 'v14';
if (!['v13', 'v14'].includes(variant)) throw new Error('--variant=v13|v14');
const fix = args.get('fix') ?? 'none';
const minutes = list('minutes', '6,7,8,9,10,11,12,13,14,15,16,18,20').map(Number);
const seeds = list('seeds', '7,99,2026').map(Number);
const dexes = list('dex', '887,4,25').map(Number);
const metas = list('meta', 'max') as Cell['meta'][];
const players = list('players', '1').map(Number);
const policy = args.get('policy') ?? 'greedy';
const standFrom = Number(args.get('stand-from') ?? 11);
const probes = args.get('probes') !== 'off';
const out = args.get('out');
if (out) writeFileSync(out, '');
const emit = (row: unknown) => {
  const line = JSON.stringify(row) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};

const data = simData();
const levelUp = data.game.levelUp;
const tuning = data.game.tuning;
type Effect = { type: string; op?: string; value?: number; cap?: number };
const effect = (id: string) => data.statCard(id).effect as Effect;

// ---------------------------------------------------------------- variants and fixes

const V13: Record<string, { value: number; maxPicks?: number }> = {
  'max-hp': { value: 20 },
  attack: { value: 1.1, maxPicks: 40 },
  speed: { value: 1.07, maxPicks: 8 },
  cooldown: { value: 0.92, maxPicks: 10 },
  defense: { value: 0.06, maxPicks: 12 },
  regen: { value: 0.9 },
  magnet: { value: 1.3, maxPicks: 6 },
  experience: { value: 1.12, maxPicks: 8 },
};
const rarity = levelUp.rarity as { odds: { minute: number; weights: number[] }[] };
if (variant === 'v13') {
  rarity.odds = [{ minute: 0, weights: levelUp.rarity.tiers.map((_, i) => (i ? 0 : 1)) }];
  for (const c of levelUp.statCards) {
    const old = V13[c.id];
    const e = c.effect as Effect;
    if (!old || e.value === undefined) continue;
    e.value = old.value;
    if (e.op === 'mul') {
      if (old.maxPicks) e.cap = old.value ** old.maxPicks;
      else delete e.cap;
    }
  }
  const spawner = tuning.spawner as { damageK: number; directionBias: { aheadShare: number } };
  spawner.damageK = 4.8;
  spawner.directionBias.aheadShare = 0.15;
  (tuning.stragglers as { aheadShare: number }).aheadShare = 0;
}

/** Power as an additive sum: each pick adds its rolled bonus to 1 + Σ (set before every pick). */
let additivePower = false;
const FIXES: Record<string, () => void> = {
  none: () => {},
  'power-cap-10': () => (effect('attack').cap = 10),
  'power-cap-20': () => (effect('attack').cap = 20),
  'power-additive': () => (additivePower = true),
  'regen-cap-6': () => (effect('regen').cap = 6),
  'regen-0.4': () => (effect('regen').value = 0.4),
  'learning-cap-1.6': () => (effect('experience').cap = 1.6),
  // The first cut's odds: no better than 40/35/20/5 after minute 15.
  'odds-flat-15': () => (rarity.odds = rarity.odds.filter((p) => p.minute <= 15)),
  // A combination: Power ceiling, Synthesis ceiling, slower XP.
  'combo-a': () => {
    effect('attack').cap = 10;
    effect('regen').cap = 6;
    effect('experience').cap = 1.6;
  },
  'combo-b': () => {
    additivePower = true;
    effect('regen').cap = 6;
    effect('experience').cap = 1.6;
  },
};
const applyFix = FIXES[fix];
if (!applyFix) throw new Error(`--fix=${Object.keys(FIXES).join('|')}`);
applyFix();
const POWER_BASE = effect('attack').value!;

emit({
  kind: 'metadata',
  variant,
  fix,
  policy,
  standFrom,
  minutes,
  seeds,
  dexes,
  metas,
  players,
  levelUp,
  spawner: tuning.spawner,
});

// ---------------------------------------------------------------- the card policy

/** A player who takes everything: preference per stat card, × the rolled tier's multiplier. */
const PREFER: Record<string, number> = {
  attack: 1.3,
  cooldown: 1.2,
  experience: 1.1,
  regen: 1.0,
  defense: 1.0,
  'max-hp': 0.9,
  magnet: 0.6,
  speed: 0.6,
  heal: 0.1,
};
const tierMul = (id: string | undefined) =>
  levelUp.rarity.tiers.find((t) => t.id === id)?.multiplier ?? 1;

interface Pick {
  minute: number;
  statId: string | null;
  rarity: string | null;
  type: string;
}

function choose(sim: Sim, log: Map<string, Pick[]>) {
  for (const c of sim.state.pendingChoices.slice()) {
    if (c.kind === 'level-up') {
      const p = sim.state.players.find((q) => q.id === c.playerId)!;
      const score = (o: (typeof c.options)[number]) => {
        if (policy === 'first') return 0;
        if (o.type === 'evolution') return 100;
        if (o.type === 'stat') return (PREFER[o.statId ?? ''] ?? 0.5) * tierMul(o.rarity) * 10;
        if (o.type === 'upgrade') return 12;
        return p.slots.length < p.maxSlots ? 11 : 1;
      };
      const card = c.options.reduce((a, o) => (score(o) > score(a) ? o : a), c.options[0]!);
      if (additivePower && card.statId === 'attack') {
        const built = p.cardMul.attack ?? 1;
        effect('attack').value = 1 + (POWER_BASE - 1) / built;
      }
      sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: card.id });
      if (additivePower) effect('attack').value = POWER_BASE;
      const picks = log.get(p.id) ?? [];
      picks.push({
        minute: sim.state.time / 60,
        statId: card.statId ?? null,
        rarity: card.rarity ?? null,
        type: card.type,
      });
      log.set(p.id, picks);
    } else if (c.kind === 'bond') {
      const moves = c.mode === 'add' ? c.loose.slice(0, 1) : c.loose.slice(0, 2);
      sim.submitIntent(c.playerId, { type: 'pickBond', choiceId: c.id, moves });
    } else sim.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.found });
  }
}

// ---------------------------------------------------------------- probes

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function upgradesOf(meta: Cell['meta']) {
  return Object.fromEntries(
    data.game.upgrades.map((u) => [
      u.id,
      meta === 'max' ? u.maxLevel : meta === 'half' ? Math.floor(u.maxLevel / 2) : 0,
    ]),
  );
}

function breakdown(sim: Sim, p: PlayerState, meta: Cell['meta'], momentumMean: number) {
  const perks = data.perks(upgradesOf(meta));
  const itemMul = (stat: string) =>
    p.item
      ? data
          .item(p.item)
          .effects.filter((e) => e.stat === stat && e.op === 'mul')
          .reduce((a, e) => a * e.value, 1)
      : 1;
  const buffs = 1 + p.buffs.attack.n * p.buffs.attack.amount;
  const momentum = momentumMultiplier(sim.ctx, p.momentum);
  const total = attackOf(sim.ctx, p);
  return {
    attackBase: p.baseAttack,
    attackTotalMul: total / p.baseAttack,
    upgrades: perks.attackMul,
    item: itemMul('attackMul'),
    buffs,
    momentum,
    momentumMeanMul: momentumMultiplier(sim.ctx, momentumMean),
    cards: p.cardMul.attack ?? 1,
    // What's left (should be 1): checks the split.
    rest:
      total /
      (p.baseAttack *
        perks.attackMul *
        itemMul('attackMul') *
        buffs *
        momentum *
        (p.cardMul.attack ?? 1)),
    cooldown: p.cooldownMul,
    cooldownCards: p.cardMul.cooldown ?? 1,
    cooldownUpgrades: perks.cooldownMul,
    cooldownItem: itemMul('cooldownMul'),
    regen: regenOf(p),
    regenCards: p.regen - perks.regen - p.itemRegen,
    regenUpgrades: perks.regen,
    regenItem: p.itemRegen,
    damageReduction: reductionOf(p),
    maxHp: p.maxHp,
    xpMul: p.xpMul,
    heldItem: p.item,
    statsTaken: { ...p.statsTaken },
    moves: p.moves.map((m) => `${m.id}:${m.level}${m.evolved ? '*' : ''}`),
  };
}

/** Live regular wild Pokémon: HP and raw contact damage; the contact after this player's defence. */
function wilds(sim: Sim, p: PlayerState) {
  const regular = sim.state.enemies.filter((e) => e.regularHit && !e.dead);
  const hp = mean(regular.map((e) => e.maxHp));
  const raw = mean(regular.map((e) => e.damage));
  const close = p.moves.some((m) => m.kind === 'melee') ? 0.75 : 1;
  const cap = tuning.spawner.regularHitCapFraction;
  const contact = Math.max(
    1,
    Math.min(raw * (1 - reductionOf(p)) * close, cap > 0 ? p.maxHp * cap : Infinity),
  );
  const scale = enemyScale(sim.ctx, sim.state.time);
  const crowd = sim.state.enemies.filter((e) => !e.dead && !e.boss && !e.legend);
  return {
    count: regular.length,
    hp,
    raw,
    contact,
    crowd: crowd.length,
    crowdHp: mean(crowd.map((e) => e.maxHp)),
    crowdRaw: mean(crowd.map((e) => e.damage)),
    hpScale: scale.hp,
    damageScale: scale.damage,
  };
}

/** Potential single-target DPS on a pinned regular-HP dummy, 30 s (neutral, close range). */
function dummyDps(sim: Sim, cell: Cell, seed: number, hp: number): number {
  const test = makeSim(cell, seed, true, true);
  test.state.time = sim.state.time;
  test.state.players.forEach((p, i) => loadBuild(test, p, sim.state.players[i]!));
  test.debugStartArena();
  const a = test.state.arena!;
  a.pillars = a.pools = test.state.world.arena!.pillars = test.state.world.arena!.pools = 0;
  resetChunks(test.ctx);
  test.state.enemies = [];
  const target = spawnDummy(test, a.x, a.y, {}, 1e12);
  target.types = [];
  target.flying = true;
  target.maxHp = hp;
  a.bossId = target.id;
  test.state.weather.current = null;
  test.state.players.forEach((p, i) => {
    p.x = p.prevX = a.x;
    p.y = p.prevY = a.y + 40 + i * 2;
    p.momentum = 0;
  });
  for (let i = 0; i < 30 / DT; i++) {
    test.step();
    test.drainEvents();
    target.x = a.x;
    target.y = a.y;
    target.speed = 0;
    target.kx = target.ky = 0;
  }
  return (1e12 - target.hp) / 30;
}

/** The v14 playtest's stats panel at minute 14 (solo, fully upgraded, species unknown). */
const FRIEND = {
  atk: Number(args.get('friend-atk') ?? 128.13),
  cooldown: 0.3,
  regen: Number(args.get('friend-regen') ?? 22.7),
  dr: 0.7,
  maxHp: 506,
  xp: 3.5,
  magnet: 8.31,
};

/**
 * Puts the playtest's panel on this player, keeping its species and item. For the harness's
 * archetype species, also a maxed loadout: the archetype's four moves at max level, evolved, in
 * one bonded slot (a strong human build after a few rifts); other species keep their moves.
 */
function asFriend(sim: Sim, p: PlayerState) {
  const plan = Object.values(archetypes).find((a) => a.dex === p.dex);
  if (plan) {
    p.moves = plan.moves.map((id) => {
      const m = newMove(sim.ctx, id, sim.ctx.d.maxMoveLevel(id));
      evolveMove(sim.ctx, p, m);
      return m;
    });
    p.slots = [plan.moves.slice(0, BOND_MAX)];
    p.active = 0;
    sim.drainEvents();
  }
  const buffs = 1 + p.buffs.attack.n * p.buffs.attack.amount;
  // The panel's ATK includes Momentum; assume a full streak (the cap) as they stood and killed.
  p.momentum = tuning.momentum.maxStacks;
  const momentum = 1 + tuning.momentum.perStack * p.momentum;
  p.attackMul = FRIEND.atk / (buffs * momentum);
  p.cooldownMul = FRIEND.cooldown;
  p.regen = FRIEND.regen - p.buffs.regen.n * p.buffs.regen.amount;
  p.itemRegen = 0;
  p.damageReduction = FRIEND.dr;
  p.maxHp = p.hp = FRIEND.maxHp;
  p.xpMul = FRIEND.xp;
  p.magnet = 78 * FRIEND.magnet;
}

/** 30 s standing still in the real crowd, from a copy of the run (not protected). */
function stand(
  sim: Sim,
  mode: 'as-is' | 'defence-only' | 'offence-only',
  meta: Cell['meta'],
  friend = false,
) {
  const copy = restoreSim(JSON.parse(JSON.stringify(sim.state)) as SimState);
  copy.state.config.invulnerable = false;
  const p = copy.state.players[0]!;
  if (friend) asFriend(copy, p);
  p.hp = p.maxHp;
  const perks = data.perks(upgradesOf(meta));
  if (mode === 'defence-only') p.attackMul /= 100;
  if (mode === 'offence-only') {
    p.regen = 0;
    p.itemRegen = 0;
    p.buffs.regen.n = 0;
    p.damageReduction = perks.damageReduction;
  }
  let hurt = 0;
  let contacts = 0;
  let healed = 0;
  let healedOther = 0;
  let downs = 0;
  let firstDown: number | null = null;
  const kills0 = copy.state.team.kills;
  const start = copy.state.time;
  const enemies: number[] = [];
  const hp: number[] = [];
  for (let i = 0; i < 30 / DT; i++) {
    copy.state.pendingChoices = [];
    copy.state.pendingLevels = 0;
    for (const q of copy.state.players) copy.setInput(q.id, { moveX: 0, moveY: 0 });
    copy.step();
    for (const e of copy.drainEvents()) {
      if (e.type === 'player-hurt' && e.playerId === p.id) {
        hurt += e.amount;
        contacts++;
      }
      if (e.type === 'player-healed' && e.playerId === p.id) healedOther += e.amount;
      if (e.type === 'player-down' && e.playerId === p.id) {
        downs++;
        firstDown ??= copy.state.time - start;
      }
    }
    healed += regenOf(p) * DT * (p.dead ? 0 : 1);
    if (i % 15 === 0) {
      enemies.push(copy.state.enemies.filter((e) => !e.dead).length);
      hp.push(p.dead ? 0 : p.hp / p.maxHp);
    }
  }
  return {
    mode,
    incomingDps: hurt / 30,
    regenDps: healed / 30,
    /** Other healing (Shell Bell, drops, moves): `player-healed` events. */
    otherHealDps: healedOther / 30,
    contactsPerSecond: contacts / 30,
    killsPerSecond: (copy.state.team.kills - kills0) / 30,
    meanEnemies: mean(enemies),
    minHpFraction: Math.min(...hp),
    endHpFraction: hp.at(-1) ?? 0,
    downs,
    firstDown,
  };
}

// ---------------------------------------------------------------- runs

for (const meta of metas)
  for (const n of players)
    for (const dex of dexes)
      for (const seed of seeds) {
        const cell: Cell = { meta, players: n, archetype: 'projectile', dex };
        const sim = makeSim(cell, seed, false, true);
        // No rifts: every checkpoint is on the map, with its crowd (bonds come only from rifts).
        sim.state.rift.checkT = 1e9;
        const log = new Map<string, Pick[]>();
        const momentumSamples: number[] = [];
        const started = Date.now();
        for (const minute of minutes) {
          while (sim.state.time + DT / 2 < minute * 60 && !sim.ended) {
            choose(sim, log);
            if (sim.state.time >= standFrom * 60)
              for (const p of sim.state.players) sim.setInput(p.id, { moveX: 0, moveY: 0 });
            else drive(sim);
            selectAttackSlot(sim);
            sim.step();
            sim.drainEvents();
            if (sim.state.tick % 30 === 0) {
              momentumSamples.push(sim.state.players[0]!.momentum);
              if (momentumSamples.length > 60) momentumSamples.shift();
            }
          }
          if (sim.ended) break;
          choose(sim, log);
          const p = sim.state.players[0]!;
          const picks = log.get(p.id) ?? [];
          const power = picks.filter((k) => k.statId === 'attack');
          const w = wilds(sim, p);
          const refHp = w.hp > 0 ? w.hp : w.crowdHp;
          const dps = probes && refHp > 0 ? dummyDps(sim, cell, seed, refHp) : null;
          emit({
            kind: 'minute',
            variant,
            fix,
            policy,
            meta,
            players: n,
            dex,
            seed,
            minute,
            level: sim.state.team.level,
            picks: picks.length,
            powerPicks: power.length,
            powerRarity: Object.fromEntries(
              levelUp.rarity.tiers.map((t) => [
                t.id,
                power.filter((k) => k.rarity === t.id).length,
              ]),
            ),
            ...breakdown(sim, p, meta, mean(momentumSamples)),
            wild: w,
            dps,
            ttk: dps ? refHp / dps : null,
            eliteTtk: dps ? w.crowdHp / dps : null,
            stand: probes
              ? (['as-is', 'defence-only', 'offence-only'] as const).map((m) => stand(sim, m, meta))
              : null,
            // The playtest's panel on this run's state (its crowd, species and moves).
            friend:
              probes && minute === 14 && meta === 'max' && n === 1
                ? (['as-is', 'defence-only', 'offence-only'] as const).map((m) =>
                    stand(sim, m, meta, true),
                  )
                : null,
          });
        }
        emit({
          kind: 'run',
          variant,
          fix,
          meta,
          players: n,
          dex,
          seed,
          reached: sim.state.time / 60,
          ms: Date.now() - started,
        });
      }
