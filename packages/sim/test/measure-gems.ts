// Manual R6 check of the gem drop rate: gems per 15-minute solo run. Never runs in CI.
//   pnpm --filter @pokesurvivor/sim gems [--seeds=1,2,3] [--dex=25,4,7,1] [--minutes=15] [--meta=half] [--mortal] [--kite]
// A solo first-choice bot (`bots.ts`) per seed and starter, with half of every permanent upgrade
// (`--meta=none|half|max`), protected so every run lasts the full
// time (`--mortal`: the bot can die, and the run ends there). Bosses are engaged like the slow
// progression run, or kiting bots leave them alive (`--kite`: they don't). Prints one JSON line per run, then the mean.
import { simData } from '../src/data.js';
import { createSim, type Sim } from '../src/index.js';
import { botInputs, pickFirst } from './bots.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
const list = (key: string, fallback: string) => (args.get(key) ?? fallback).split(',').map(Number);
const seeds = list('seeds', '1,2,3,4,5,6,7,8');
const dexes = list('dex', '25,4,7,1');
const minutes = Number(args.get('minutes') ?? 15);
const mortal = args.has('mortal');
const kite = args.has('kite');
const meta = args.get('meta') ?? 'half';
if (!['none', 'half', 'max'].includes(meta)) throw new Error('--meta=none|half|max');

function engageBoss(sim: Sim): void {
  const boss = sim.state.enemies.find((e) => e.boss && !e.dead);
  if (!boss) return;
  for (const p of sim.state.players) {
    const dx = boss.x - p.x;
    const dy = boss.y - p.y;
    const d = Math.hypot(dx, dy);
    sim.setInput(p.id, { moveX: d > 20 ? dx / d : 0, moveY: d > 20 ? dy / d : 0 });
  }
}

/** Permanent upgrades: none, half of each (the default, a typical player) or all maxed. */
function upgradesFor(m: string): Record<string, number> {
  const { upgrades } = simData().game;
  return Object.fromEntries(
    upgrades.map((u) => [
      u.id,
      m === 'max' ? u.maxLevel : m === 'half' ? Math.floor(u.maxLevel / 2) : 0,
    ]),
  );
}

const rows: { gems: number; time: number }[] = [];
for (const seed of seeds) {
  for (const dex of dexes) {
    const sim = createSim({
      seed,
      players: [{ id: 'bot', dex, upgrades: upgradesFor(meta) }],
      ...(mortal ? {} : { debug: { invulnerable: true } }),
    });
    while (sim.state.time < minutes * 60 && !sim.ended) {
      pickFirst(sim);
      botInputs(sim);
      if (!kite) engageBoss(sim);
      sim.step();
      sim.drainEvents();
    }
    const t = sim.state.team;
    const row = {
      seed,
      dex,
      time: Math.floor(sim.state.time),
      kills: t.kills,
      bosses: t.bosses,
      tickets: t.tickets,
      gems: t.gems,
      gemsOnGround: sim.state.pickups.filter((p) => p.kind === 'gem').length,
    };
    rows.push({ gems: t.gems, time: sim.state.time });
    console.log(JSON.stringify(row));
  }
}
const mean = rows.reduce((a, r) => a + r.gems, 0) / rows.length;
const perMinute =
  rows.reduce((a, r) => a + r.gems, 0) / (rows.reduce((a, r) => a + r.time, 0) / 60);
console.log(
  JSON.stringify({
    runs: rows.length,
    minutes,
    meta,
    mortal,
    kite,
    meanGems: Math.round(mean * 100) / 100,
    gemsPerMinute: Math.round(perMinute * 1000) / 1000,
  }),
);
