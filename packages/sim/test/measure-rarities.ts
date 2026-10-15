// Manual R9 check of stat card rarities. Never runs in CI.
//   pnpm --filter @pokesurvivor/sim rarities --variant=after --out=after.jsonl
//   pnpm --filter @pokesurvivor/sim rarities --variant=before --out=before.jsonl
// `before` puts back v13's cards for the whole run: the old values, no rarities, and the old pick
// limits as ceilings (value^maxPicks, which is the same limit while every pick has one value).
// Per cell, a protected natural run is checkpointed at each minute, with one of two policies:
// `natural` takes the first card (as the other harnesses), `offence` takes Power, else Reflexes,
// else the first card (a player who wants damage). Each checkpoint records what the stat cards
// built for every player (Power, cooldown and armor) and the wild Pokémon's regular max HP.
import { appendFileSync, writeFileSync } from 'node:fs';
import { simData } from '../src/data.js';
import type { PlayerState, Sim } from '../src/index.js';
import { rarityWeights } from '../src/rarity.js';
import { naturalRun, type Cell } from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
const list = (key: string, fallback: string) => (args.get(key) ?? fallback).split(',');
const variant = args.get('variant') ?? 'after';
if (!['before', 'after'].includes(variant)) throw new Error('--variant=before|after');
const minutes = list('minutes', '5,10,15,20,30').map(Number);
const seeds = list('seeds', '7,99,2026').map(Number);
const players = list('players', '1,3,4').map(Number);
const metas = list('meta', 'half,max') as Cell['meta'][];
const archetypes = list('archetypes', 'projectile,melee,area') as Cell['archetype'][];
const policies = list('policies', 'natural,offence') as ('natural' | 'offence')[];
const out = args.get('out');
if (out) writeFileSync(out, '');
const emit = (row: unknown) => {
  const line = JSON.stringify(row) + '\n';
  if (out) appendFileSync(out, line);
  else process.stdout.write(line);
};

/** v13's stat cards (levelup.json before R9): value and pick limit. */
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

// Every sim shares the loaded data: put v13's cards back at the source for `before`.
const levelUp = simData().game.levelUp;
if (variant === 'before') {
  const rarity = levelUp.rarity as { odds: { minute: number; weights: number[] }[] };
  rarity.odds = [{ minute: 0, weights: levelUp.rarity.tiers.map((_, i) => (i ? 0 : 1)) }];
  for (const c of levelUp.statCards) {
    const old = V13[c.id];
    const e = c.effect as { type: string; op?: string; value?: number; cap?: number };
    if (!old || e.value === undefined) continue;
    e.value = old.value;
    // Armor keeps its 0.7 stat cap (12 × 0.06 passes it anyway).
    if (e.op === 'mul') {
      if (old.maxPicks) e.cap = old.value ** old.maxPicks;
      else delete e.cap;
    }
  }
}
emit({
  kind: 'metadata',
  variant,
  minutes,
  seeds,
  players,
  metas,
  archetypes,
  policies,
  levelUp,
  // Expected rarity multiplier at each checkpoint (1 before).
  expectedMultiplier: minutes.map((m) => {
    const w = rarityWeights(levelUp.rarity.odds, m);
    const total = w.reduce((a, b) => a + b, 0);
    return w.reduce((a, x, i) => a + (x / total) * levelUp.rarity.tiers[i]!.multiplier, 0);
  }),
});

const OFFENCE = ['attack', 'cooldown'];
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Takes Power, else Reflexes, else the first card. */
function pickOffence(sim: Sim) {
  for (const c of sim.state.pendingChoices.slice()) {
    if (c.kind !== 'level-up') continue;
    const card =
      OFFENCE.map((id) => c.options.find((o) => o.statId === id)).find(Boolean) ?? c.options[0];
    sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: card?.id ?? '' });
  }
}

for (const policy of policies)
  for (const meta of metas)
    for (const n of players)
      for (const archetype of archetypes)
        for (const seed of seeds) {
          const cell: Cell = { meta, players: n, archetype };
          const started = Date.now();
          // Damage reduction that doesn't come from cards: upgrades at the start, plus the item.
          let baseDr: number[] | null = null;
          const rarities: Record<string, number> = {};
          const seen = new Set<number>();
          const hp: Record<number, number> = {};
          const observe = (sim: Sim) => {
            baseDr ??= sim.state.players.map((p) => p.defense);
            for (const c of sim.state.pendingChoices)
              if (c.kind === 'level-up' && !seen.has(c.id)) {
                seen.add(c.id);
                for (const o of c.options)
                  if (o.rarity) rarities[o.rarity] = (rarities[o.rarity] ?? 0) + 1;
              }
            if (policy === 'offence') pickOffence(sim);
            // Regular wild max HP (no elites, bosses or legends) at each checkpoint minute.
            const m = Math.round(sim.state.time / 60);
            if (minutes.includes(m) && Math.abs(sim.state.time - m * 60) < 0.05) {
              const regular = sim.state.enemies.filter((e) => e.regularHit && !e.dead);
              if (regular.length) hp[m] = mean(regular.map((e) => e.maxHp));
            }
          };
          const snaps = naturalRun(cell, seed, minutes, true, () => {}, observe);
          const itemDr = (p: PlayerState) =>
            p.item
              ? simData()
                  .item(p.item)
                  .effects.filter((e) => e.stat === 'defense' && e.op === 'add')
                  .reduce((a, e) => a + e.value, 0)
              : 0;
          for (const snap of snaps)
            emit({
              kind: 'checkpoint',
              variant,
              policy,
              ...cell,
              seed,
              minute: snap.minute,
              level: snap.level,
              wildHp: hp[snap.minute] ?? null,
              builds: snap.builds.map((p, i) => ({
                power: p.cardMul.attack ?? 1,
                cooldown: p.cardMul.cooldown ?? 1,
                // Defence the Armor cards added, and the damage taken multiplier of the whole.
                armorDefense: Math.max(0, p.defense - (baseDr?.[i] ?? 0) - itemDr(p)),
                damageTakenMul: 1 / (1 + p.defense),
                picks: {
                  attack: p.statsTaken.attack ?? 0,
                  cooldown: p.statsTaken.cooldown ?? 0,
                  defense: p.statsTaken.defense ?? 0,
                },
              })),
            });
          emit({
            kind: 'run',
            variant,
            policy,
            ...cell,
            seed,
            reached: snaps.at(-1)?.minute ?? 0,
            rarities,
            ms: Date.now() - started,
          });
        }
