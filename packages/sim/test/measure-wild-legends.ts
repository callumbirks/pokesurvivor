// Manual measurement of wild legendaries (`tuning.wildLegends`). Never runs in CI.
//   pnpm --filter @pokesurvivor/sim wild-legends --out=wl.jsonl
//   (--minutes=30,45,60,90 --meta=max,half --dex=887,25 --seeds=7,99 --stand=60 --cap=80
//    --defense-max=2; --cap / --defense-max mirror the live config, default 80 / 2)
//
// Per cell (species × meta × seed), one protected solo run (invulnerable, a greedy human-like
// card policy, the rift harness's bot: it seeks loot and rifts and fights at its moves' range) is
// snapshotted at each minute. From each snapshot:
//   duel   the build alone against each legendary in LEGENDS (no horde), the bot engaging as it
//          does in the run; HP topped up every tick so it never goes down; defence at least
//          `defense.max`. Time to kill (120 s max), the legendary's hits (mean and max, also as a
//          share of max HP) and its damage per second over the fight.
//   stand  60 s standing still (auto-aim) from a copy of the run, real horde, not protected:
//          without wild legendaries, and with one spawned at the start. Survived or not, when.
//   move   the same, the bot moving and fighting as in the run.
//   Both from a few starting points after the minute (`--offsets`, default 0,20,40 s), with the
//   map cleared first (the protected run lets a crowd pile up on the bot; `--fresh=off` keeps it).
import { appendFileSync, writeFileSync } from 'node:fs';
import { DT } from '../src/constants.js';
import { simData } from '../src/data.js';
import { restoreSim, type PlayerState, type Sim } from '../src/index.js';
import { defenseOf } from '../src/players.js';
import type { SimState } from '../src/state.js';
import { spawnWildLegend } from '../src/wildlegends.js';
import { drive, makeSim, selectAttackSlot, type Cell } from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
const list = (key: string, fallback: string) => (args.get(key) ?? fallback).split(',');
const minutes = list('minutes', '30,45,60,90').map(Number);
const metas = list('meta', 'max,half') as Cell['meta'][];
const dexes = list('dex', '887,25').map(Number);
const seeds = list('seeds', '7,99').map(Number);
const standSeconds = Number(args.get('stand') ?? 60);
/** Stand / move windows start with the map cleared (`--fresh=off`: with the run's crowd). */
const fresh = args.get('fresh') !== 'off';
/** Seconds after each minute the stand / move windows start at. */
const offsets = list('offsets', '0,20,40').map(Number);
/** Mewtwo (Psychic: shoots, beams), Groudon (Ground: charges, rains), Lugia (Psychic/Flying). */
const LEGENDS = list('legends', '150,383,249').map(Number);
const out = args.get('out');
if (out) writeFileSync(out, '');
const emit = (row: unknown) => {
  const line = JSON.stringify(row) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};

// The live config (v8): cap 80, defence +200% at most.
const data = simData();
const tuning = data.game.tuning as {
  spawner: { cap: number };
  defense: { max: number };
  wildLegends: { maxAlive: number };
};
tuning.spawner.cap = Number(args.get('cap') ?? 80);
tuning.defense.max = Number(args.get('defense-max') ?? 2);
const MAX_ALIVE = tuning.wildLegends.maxAlive;
emit({ kind: 'metadata', minutes, metas, dexes, seeds, LEGENDS, tuning: data.game.tuning });

// ---------------------------------------------------------------- the card policy

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
  data.game.levelUp.rarity.tiers.find((t) => t.id === id)?.multiplier ?? 1;

/** Evolutions, then the best stat card by rarity × preference, then upgrades, then new moves. */
function choose(sim: Sim) {
  for (const c of sim.state.pendingChoices.slice()) {
    if (c.kind === 'level-up') {
      const p = sim.state.players.find((q) => q.id === c.playerId)!;
      const score = (o: (typeof c.options)[number]) => {
        if (o.type === 'evolution') return 100;
        if (o.type === 'stat') return (PREFER[o.statId ?? ''] ?? 0.5) * tierMul(o.rarity) * 10;
        if (o.type === 'upgrade') return 12;
        return p.slots.length < p.maxSlots ? 11 : 1;
      };
      const card = c.options.reduce((a, o) => (score(o) > score(a) ? o : a), c.options[0]!);
      sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: card.id });
    } else if (c.kind === 'bond') {
      const moves = c.mode === 'add' ? c.loose.slice(0, 1) : c.loose.slice(0, 2);
      sim.submitIntent(c.playerId, { type: 'pickBond', choiceId: c.id, moves });
    } else sim.submitIntent(c.playerId, { type: 'pickItem', choiceId: c.id, itemId: c.found });
  }
}

// ---------------------------------------------------------------- probes

const copyOf = (sim: Sim): Sim =>
  restoreSim(JSON.parse(JSON.stringify(sim.state)) as SimState, sim.ctx.d.game);

/** Nothing else happening: no rift, events, weather or spawns. */
function isolate(sim: Sim) {
  const s = sim.state;
  s.rift.open = null;
  s.rift.checkT = 1e9;
  s.events.nextT = s.events.thiefT = 1e9;
  s.events.current = null;
  s.weather.current = null;
  s.weather.checkT = 1e9;
}

function build(p: PlayerState, sim: Sim) {
  return {
    level: sim.state.team.level,
    maxHp: Math.round(p.maxHp),
    defense: +defenseOf(sim.ctx, p).toFixed(2),
    attackMul: +p.attackMul.toFixed(2),
    cooldownMul: +p.cooldownMul.toFixed(3),
    regen: +p.regen.toFixed(1),
    moves: p.moves.map((m) => `${m.id}:${m.level}${m.evolved ? '*' : ''}`),
  };
}

/** The build alone against one legendary (HP topped up every tick). */
function duel(sim: Sim, dex: number) {
  const copy = copyOf(sim);
  isolate(copy);
  const s = copy.state;
  s.config.noSpawns = true;
  s.config.invulnerable = false;
  s.enemies = [];
  s.pickups = [];
  s.hazards = [];
  s.projectiles = s.projectiles.filter((pr) => pr.friendly);
  const p = s.players[0]!;
  p.defense = Math.max(p.defense, tuning.defense.max);
  p.hp = p.maxHp;
  copy.drainEvents();
  const e = spawnWildLegend(copy.ctx, dex)!;
  const hits: number[] = [];
  let t = 0;
  while (!e.dead && t < 120) {
    s.pendingChoices = [];
    s.pendingLevels = 0;
    drive(copy);
    selectAttackSlot(copy);
    copy.step();
    t += DT;
    for (const ev of copy.drainEvents())
      if (ev.type === 'player-hurt' && ev.playerId === p.id) hits.push(ev.amount);
    p.hp = p.maxHp;
    p.dead = false;
  }
  const sum = hits.reduce((a, b) => a + b, 0);
  return {
    dex,
    hp: Math.round(e.maxHp),
    contact: Math.round(e.damage),
    ttk: e.dead ? +t.toFixed(1) : null,
    hits: hits.length,
    hitMean: hits.length ? Math.round(sum / hits.length) : 0,
    hitMax: Math.max(0, ...hits),
    hitMaxPct: +((100 * Math.max(0, ...hits)) / p.maxHp).toFixed(1),
    dps: Math.round(sum / t),
    dpsPct: +((100 * sum) / t / p.maxHp).toFixed(2),
  };
}

/** `standSeconds` from a copy of the run with the real horde, standing still or moving. */
function survive(sim: Sim, mode: 'stand' | 'move', legend: boolean) {
  const copy = copyOf(sim);
  isolate(copy);
  const s = copy.state;
  s.config.invulnerable = false;
  // Only the one we spawn (natural spawns could add a second in the window).
  (copy.ctx.d.game.tuning.wildLegends as { maxAlive: number }).maxAlive = 0;
  const p = s.players[0]!;
  p.hp = p.maxHp;
  // The protected run lets a crowd pile up on the bot: start clear, the horde arrives as usual.
  if (fresh) {
    s.enemies = [];
    s.hazards = [];
    s.projectiles = s.projectiles.filter((pr) => pr.friendly);
  }
  if (legend) spawnWildLegend(copy.ctx, LEGENDS[0]);
  let downAt: number | null = null;
  let taken = 0;
  let fromLegend = 0;
  for (let i = 0; i < standSeconds / DT && downAt === null; i++) {
    choose(copy);
    if (mode === 'stand') copy.setInput(p.id, { moveX: 0, moveY: 0 });
    else {
      drive(copy);
      selectAttackSlot(copy);
    }
    copy.step();
    for (const ev of copy.drainEvents())
      if (ev.type === 'player-hurt' && ev.playerId === p.id) taken += ev.amount;
    const last = p.balance.lastHit;
    if (p.dead) {
      downAt = +(i * DT).toFixed(1);
      if (last?.tier === 'wildLegend') fromLegend++;
    }
  }
  (copy.ctx.d.game.tuning.wildLegends as { maxAlive: number }).maxAlive = MAX_ALIVE;
  const legendLeft = s.enemies.find((e) => e.wildLegend);
  return {
    mode,
    legend,
    survived: downAt === null,
    downAt,
    downByLegend: fromLegend > 0,
    dps: Math.round(taken / Math.min(standSeconds, downAt ?? standSeconds)),
    legendKilled: legend ? !legendLeft || legendLeft.dead : null,
  };
}

// ---------------------------------------------------------------- the runs

for (const dex of dexes)
  for (const meta of metas)
    for (const seed of seeds) {
      const cell: Cell = { dex, archetype: 'projectile', meta, players: 1 };
      const sim = makeSim(cell, seed, false, true);
      const started = Date.now();
      for (const minute of minutes) {
        while (sim.state.time + DT / 2 < minute * 60) {
          choose(sim);
          drive(sim);
          selectAttackSlot(sim);
          sim.step();
          sim.drainEvents();
        }
        // Don't probe from inside a rift: finish it first (it pauses the map).
        while (sim.state.arena) {
          choose(sim);
          drive(sim);
          sim.step();
          sim.drainEvents();
        }
        const p = sim.state.players[0]!;
        const at = +(sim.state.time / 60).toFixed(2);
        const buildNow = build(p, sim);
        const soFar = p.balance.wildLegends.length;
        const duels = LEGENDS.map((l) => duel(sim, l));
        // Stand / move windows from a few starting points (the run goes on, protected, between).
        const windows = [];
        for (let k = 0; k < offsets.length; k++) {
          const until = minute * 60 + offsets[k]!;
          while (sim.state.time + DT / 2 < until || sim.state.arena) {
            choose(sim);
            drive(sim);
            selectAttackSlot(sim);
            sim.step();
            sim.drainEvents();
          }
          windows.push(
            survive(sim, 'stand', false),
            survive(sim, 'stand', true),
            survive(sim, 'move', false),
            survive(sim, 'move', true),
          );
        }
        const row = {
          kind: 'probe',
          dex,
          meta,
          seed,
          minute,
          at,
          build: buildNow,
          wildLegendsSoFar: soFar,
          duels,
          stand: windows,
        };
        emit(row);
        process.stderr.write(
          `${dex} ${meta} ${seed} min ${minute}: ${((Date.now() - started) / 1000).toFixed(0)} s\n`,
        );
      }
    }
