// Manual check of the solo run reward rates the server's run caps (`runCaps` in
// `apps/server/src/economy/config.ts`) must stay above. Never runs in CI.
//   pnpm --filter @pokesurvivor/sim rewards [--seeds=1,2,3] [--archetypes=projectile,melee,area] [--minutes=90] [--meta=max] [--chests]
// A protected solo bot per seed and archetype (the rift harness's driver: it takes rifts, fights
// the legendaries and walks to pickups) with every permanent upgrade (`--meta`). Prints one JSON
// line per run with per-minute rates, then the highest rate of each quantity over all runs.
// `--chests`: outside rifts the bot heads for the nearest locked chest within a screen (and walks
// straight on when there is none), for an upper bound on chests opened.
import { DT } from '../src/constants.js';
import type { Sim } from '../src/index.js';
import { specialsNear } from '../src/world.js';
import { pickFirst } from './bots.js';
import {
  archetypes,
  drive,
  makeSim,
  selectAttackSlot,
  type Archetype,
  type Meta,
} from './measure-rifts.js';

const args = new Map(
  process.argv.slice(2).map((s) => {
    const [k, ...v] = s.replace(/^--/, '').split('=');
    return [k!, v.join('=')];
  }),
);
const seeds = (args.get('seeds') ?? '1,2,3').split(',').map(Number);
const kinds = (args.get('archetypes') ?? Object.keys(archetypes).join(',')).split(
  ',',
) as Archetype[];
const minutes = Number(args.get('minutes') ?? 90);
const meta = (args.get('meta') ?? 'max') as Meta;
const chests = args.has('chests');

/** Walks the player to the nearest locked chest in sight, or straight east. */
function huntChests(sim: Sim): void {
  if (sim.state.arena || sim.state.rift.open) return;
  for (const p of sim.state.players) {
    let best = Infinity;
    let dx = 1;
    let dy = 0;
    for (const prop of specialsNear(sim.ctx, p.x, p.y, 700)) {
      if (prop.type !== 'big-chest') continue;
      const d = Math.hypot(prop.x - p.x, prop.y - p.y);
      if (d < best) {
        best = d;
        dx = d > 20 ? (prop.x - p.x) / d : 0;
        dy = d > 20 ? (prop.y - p.y) / d : 0;
      }
    }
    sim.setInput(p.id, { moveX: dx, moveY: dy });
  }
}

const rows: Record<string, number>[] = [];
for (const seed of seeds) {
  for (const archetype of kinds) {
    const sim = makeSim({ archetype, meta, players: 1 }, seed, false, true);
    while (sim.state.time + DT / 2 < minutes * 60 && !sim.ended) {
      pickFirst(sim);
      drive(sim);
      selectAttackSlot(sim);
      if (chests) huntChests(sim);
      sim.step();
      sim.drainEvents();
    }
    const m = sim.state.time / 60;
    const p = sim.summary().players[0]!;
    const per = (n: number) => Math.round((n / m) * 1000) / 1000;
    const row = {
      seed,
      minutes: Math.round(m * 10) / 10,
      level: p.level,
      kills: per(p.kills),
      bosses: per(p.bosses),
      coinMul: p.coinMul,
      coins: per(p.rewardCoins),
      coinsTime: per(p.rewardParts.time),
      coinsDefeated: per(p.rewardParts.defeated),
      coinsBosses: per(p.rewardParts.bosses),
      coinsCollected: per(p.rewardParts.collected),
      ticketsX1: per(p.tickets),
      ticketsX10: per(p.tickets10),
      gems: per(p.gems),
      shinies: per(p.shinies.length),
      chests: per(p.progress.chestsOpened),
      items: per(p.progress.itemsEquipped.length),
      evolutions: per(p.progress.movesEvolved.length),
      riftWins: per(p.progress.riftWins.length),
      rescues: per(p.progress.rescued.length),
    };
    rows.push(row);
    console.log(JSON.stringify({ archetype, ...row }));
  }
}
const keys = Object.keys(rows[0] ?? {}).filter((k) => !['seed', 'minutes'].includes(k));
console.log(
  JSON.stringify({
    max: Object.fromEntries(keys.map((k) => [k, Math.max(...rows.map((r) => r[k]!))])),
  }),
);
