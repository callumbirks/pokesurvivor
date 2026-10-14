/** Manual Monte Carlo model; no database, writes, CI hooks, or balance assertions. */
import { writeFileSync, readFileSync } from 'node:fs';
import { getServerData } from '../../apps/server/src/data.ts';
import { buildBannerPool, rollPulls } from '../../apps/server/src/gacha/engine.ts';
import { seededRng } from '../../apps/server/src/random.ts';
import { newSaveData } from '../../apps/server/src/saves/schema.ts';
import { checkAchievements } from '../../apps/server/src/progress/achievements.ts';
import {
  ensureMissions,
  advanceMissions,
  claimMission,
} from '../../apps/server/src/progress/missions.ts';
import { capRunStats, isRescuable } from '../../apps/server/src/runs/caps.ts';
import { DEFAULT_ECONOMY } from '../../apps/server/src/economy/config.ts';
import { simData } from '../../packages/sim/src/data.ts';
import { makeRand, seedRng } from '../../packages/sim/src/rng.ts';
import { rollRoster } from '../../packages/sim/src/spawner.ts';

const args = process.argv.slice(2);
const arg = (key, fallback) => {
  const i = args.indexOf(`--${key}`);
  return i < 0 ? fallback : args[i + 1];
};
if (args.includes('--help')) {
  console.log(`Run from the tools package: pnpm exec tsx gacha/collection.js [options]
  --trials 2000 --seed collection-v1 --regions kanto,paldea
  --options current,base-only,A,B,C --mode both|pulls|play
  --pull-style multi|single --max-pulls 30000 --max-hours 500
  --pull-snapshots 100,250,500,1000,2000,4000
  --hour-snapshots 2,5,10,20,40,80 --profile path.json --out path.json
Profile JSON overrides the explicit play assumptions; see README.md in this folder.
Results contain censor counts and mean standard errors; censored means are null.`);
  process.exit(0);
}
const trials = Number(arg('trials', 2000));
const seed = arg('seed', 'collection-v1');
const mode = arg('mode', 'both');
const pullStyle = arg('pull-style', 'multi');
const maxPulls = Number(arg('max-pulls', 30000));
const maxHours = Number(arg('max-hours', 500));
const pullSnapshots = arg('pull-snapshots', '100,250,500,1000,2000,4000').split(',').map(Number);
const hourSnapshots = arg('hour-snapshots', '2,5,10,20,40,80').split(',').map(Number);
const profile = {
  runMinutes: 15,
  downtimeMinutes: 2,
  hoursPerDay: 1,
  killsPerMapMinute: 70,
  riftEnterChance: 0.8,
  riftWinChance: 0.65,
  riftApproachSeconds: 10,
  riftWinSeconds: 45,
  bossKillChance: 0.8,
  bossSeconds: 25,
  pickupChance: 0.9,
  thiefKillChance: 0.7,
  rescueSuccess: 0.6,
  rescueSeconds: 60,
  chestsPerMapHour: 2,
  level: 30,
  evolutionsPerRun: 1,
  coop: false,
  nonGacha: true,
  ...(arg('profile') ? JSON.parse(readFileSync(arg('profile'), 'utf8')) : {}),
};
if (
  !Number.isInteger(trials) ||
  trials < 1 ||
  !['both', 'pulls', 'play'].includes(mode) ||
  !['single', 'multi'].includes(pullStyle) ||
  maxPulls < 1 ||
  maxHours < 1 ||
  profile.runMinutes <= 0 ||
  profile.hoursPerDay <= 0 ||
  [...pullSnapshots, ...hourSnapshots].some((x) => !Number.isFinite(x) || x < 0)
) {
  throw new Error('Invalid trials, mode, pull style, horizon, profile, or snapshot');
}
const data = getServerData();
const sd = simData();
const tuning = data.tuning;
const allLegends = data.pokedex.filter((p) => p.legendary && data.hasSprite(p.dex));
const rescuePool = data.pokedex.filter((p) => isRescuable(p.dex));
const definitions = {
  current: {},
  'base-only': { base: 0.15 },
  'no-pity': { noPity: true },
  A: { base: 0.15, from: 180, step: 0.02, hard: 220 },
  B: { base: 0.1, from: 240, step: 0.01, hard: 300 },
  C: { base: 0.3, from: 120, step: 0.03, hard: 160, unownedFirst: true },
};
const options = arg('options', 'current,base-only,A,B,C')
  .split(',')
  .map((id) => {
    if (!(id in definitions)) throw new Error(`Unknown option ${id}`);
    const def = definitions[id];
    const config = structuredClone(data.gacha);
    if (def.base !== undefined) {
      const oldBase = config.rates.find((r) => r.rarity === 5).weight;
      config.rates.find((r) => r.rarity === 1).weight += oldBase - def.base;
      config.rates.find((r) => r.rarity === 5).weight = def.base;
    }
    if (def.from) config.softPity = { from: def.from, stepPerPull: def.step };
    if (def.hard) config.hardPity = def.hard;
    if (def.noPity) {
      config.softPity = { from: 1000000000, stepPerPull: 0 };
      config.hardPity = 1000000000;
    }
    return { id, config, unownedFirst: !!def.unownedFirst };
  });
const pools = arg('regions', 'kanto,paldea')
  .split(',')
  .map((id) => {
    const banner = data.gacha.banners.find((b) => b.id === id);
    if (!banner) throw new Error(`Unknown region ${id}`);
    return buildBannerPool(banner, data.pokedex, data.hasSprite);
  });
const names = data.gacha.rarities.map((r) => r.name);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const average = (xs) => sum(xs) / xs.length;
const range = (rng, ab) => ab[0] + rng() * (ab[1] - ab[0]);
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
const poisson = (rng, lambda) => {
  let n = 0,
    product = 1;
  do {
    product *= rng();
    n++;
  } while (product > Math.exp(-lambda));
  return n - 1;
};
const weighted = (rng, xs, weights) => {
  let x = rng() * sum(weights);
  return xs.find((_, i) => (x -= weights[i]) <= 0) ?? xs.at(-1);
};
const estimate = (xs, expected) => {
  const finite = xs.filter((v) => v !== null);
  const mean = finite.length ? average(finite) : null;
  const se =
    finite.length > 1
      ? Math.sqrt(sum(finite.map((x) => (x - mean) ** 2)) / (finite.length - 1) / finite.length)
      : null;
  const sorted = finite.toSorted((a, b) => a - b);
  return {
    mean: finite.length === expected ? mean : null,
    se: finite.length === expected ? se : null,
    p10: sorted[Math.floor(sorted.length * 0.1)] ?? null,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? null,
    censored: expected - finite.length,
  };
};

function collector(pool, option, trialSeed) {
  const rng = seededRng(trialSeed);
  const state = {
    rng,
    owned: new Set(),
    shiny: new Set(),
    pity: 0,
    pulls: 0,
    completed: Array(5).fill(null),
    completedHours: Array(5).fill(null),
    fractions: {},
    hourFractions: {},
    refundAt: {},
    pullsAtHour: {},
    refund: 0,
    counts: Array(5).fill(0),
    legendaryDraws: 0,
    sources: {},
    metrics: {},
    wallet: { x1: 0, x10: 0 },
    save: newSaveData(),
    hour: 0,
  };
  const sizes = names.map((_, i) => pool.byRarity.get(i + 1)?.length ?? 0);
  const locked = {
    userId: trialSeed,
    data: state.save,
    wallet: {
      credit(currency, amount, reason) {
        if (currency === 'tickets_x1') state.wallet.x1 += amount;
        if (currency === 'tickets_x10') state.wallet.x10 += amount;
        if (currency.startsWith('tickets_')) {
          const equivalent = amount * (currency === 'tickets_x10' ? 10 : 1);
          state.sources[reason] = (state.sources[reason] ?? 0) + equivalent;
        }
      },
    },
  };
  const mark = () => {
    for (let i = 0; i < 5; i++)
      if (state.completed[i] === null && state.counts[i] === sizes[i]) {
        state.completed[i] = state.pulls;
        state.completedHours[i] = state.hour;
      }
  };
  const grant = (dex, shiny = false) => {
    const mon = data.pokemonByDex.get(dex);
    if (!state.owned.has(dex) && mon.gen === pool.gen && data.hasSprite(dex))
      state.counts[mon.rarity - 1]++;
    state.owned.add(dex);
    state.save.owned[dex] ??= { at: 1, from: 'wild' };
    if (shiny) {
      state.shiny.add(dex);
      state.save.shiny[dex] ??= { at: 1, from: 'wild' };
    }
    mark();
  };
  const fraction = () => state.counts.map((n, i) => (sizes[i] ? n / sizes[i] : 1));
  const draw = (count) => {
    // Snapshot the pre-batch collection: rollPulls mutates its input sets.
    const outcome = rollPulls({
      config: option.config,
      pool,
      count,
      pity: state.pity,
      owned: new Set(state.owned),
      shiny: new Set(state.shiny),
      hasShiny: data.hasShinySprite,
      rng,
    });
    state.pity = outcome.pity;
    for (const result of outcome.results) {
      // Option C is deliberately a hypothetical engine change, restricted to normal 1–4★.
      if (option.unownedFirst && !result.shiny && result.rarity < 5) {
        const missing = pool.byRarity.get(result.rarity).filter((p) => !state.owned.has(p.dex));
        if (missing.length) {
          result.dex = pick(rng, missing).dex;
          result.refund = 0;
        }
      }
      if (!result.shiny)
        result.refund = state.owned.has(result.dex)
          ? option.config.duplicateRefund.find((r) => r.rarity === result.rarity).coins
          : 0;
      state.pulls++;
      state.legendaryDraws += Number(result.rarity === 5);
      state.refund += result.refund;
      grant(result.dex, result.shiny);
      if (pullSnapshots.includes(state.pulls)) {
        state.fractions[state.pulls] = fraction();
        state.refundAt[state.pulls] = state.refund;
      }
    }
    state.save.stats.pulls = state.pulls;
  };
  return { state, locked, grant, mark, draw, fraction };
}

/** Macro run: exact rewards/pools; movement, combat success, kills and exploration are inputs. */
let runCache = new Map();

function generateRun(s, userId, runIndex) {
  const rng = seededRng(`${userId}:run:${runIndex}`);
  const P = profile,
    R = tuning.rift,
    E = tuning.events;
  const runS = P.runMinutes * 60;
  const roster = rollRoster({ d: sd, rand: makeRand(seedRng(Math.floor(rng() * 2 ** 32))) });
  const beatenAtStart = new Set(Object.keys(s.save.legendsBeaten).map(Number));
  let riftEntries = 0,
    riftOpens = 0,
    riftShinies = 0;
  const legendWeights = allLegends.map((p) => (beatenAtStart.has(p.dex) ? 1 : R.unbeatenWeight));
  const progress = {
    defeatsByType: {},
    chestsOpened: 0,
    itemsEquipped: [],
    movesEvolved: [],
    riftWins: [],
    legendariesDefeated: [],
    rescued: [],
  };
  let x1 = 0,
    x10 = 0,
    kills = 0,
    bosses = 0,
    mapS = 0;
  let nextRift = R.startAfter + R.checkEvery,
    misses = 0;
  let nextEvent = range(rng, E.every),
    eventLeft = 0,
    lastEvent = null;
  let nextThief = range(rng, E.thiefFirst),
    thieves = 0,
    bossBusy = 0;
  const shinies = [];
  const sources = {};
  const source = (name, pulls) => {
    sources[name] = (sources[name] ?? 0) + pulls;
  };
  const ticket = (kind, n, name, guaranteed = false) => {
    for (let j = 0; j < n; j++)
      if (guaranteed || rng() < P.pickupChance) {
        if (kind === 10) x10++;
        else x1++;
        source(name, kind);
      }
  };
  const catchShiny = (mon, chance) => {
    if (data.hasShinySprite(mon.dex) && rng() < chance) shinies.push(mon.dex);
  };
  for (let t = 1; t <= runS; t++) {
    // Rifts pause map spawning, event/thief timers and pending bosses, but run time continues.
    if (t >= nextRift) {
      if (rng() < R.chance * (1 + misses)) {
        misses = 0;
        riftOpens++;
        if (rng() < P.riftEnterChance) {
          riftEntries++;
          const mon = weighted(rng, allLegends, legendWeights);
          const won = rng() < P.riftWinChance;
          const duration =
            P.riftApproachSeconds +
            (won ? P.riftWinSeconds + R.returnAfterWin : R.arenaTime + R.returnAfterLoss);
          if (t + duration <= runS && won) {
            progress.riftWins.push(pick(rng, mon.types));
            progress.legendariesDefeated.push(mon.dex);
            bosses++;
            kills++;
            ticket(1, R.rewardTickets, 'rift', true);
            if (rng() < tuning.pickups.legendaryTicket10Chance) ticket(10, 1, 'rift', true);
            const before = shinies.length;
            catchShiny(mon, R.shinyChance);
            riftShinies += shinies.length - before;
            progress.itemsEquipped.push(pick(rng, data.items).id);
          }
          t += Math.ceil(duration);
          nextRift = t + R.checkEvery;
        } else nextRift = t + R.ttl + R.checkEvery;
      } else {
        misses++;
        nextRift += R.checkEvery;
      }
    }
    if (t > runS) break;
    mapS++;
    const due = roster.bosses.find((b) => b.at <= t && !b.done);
    if (due) {
      due.done = true;
      bossBusy = P.bossSeconds;
      if (rng() < P.bossKillChance) {
        bosses++;
        kills++;
        if (rng() < tuning.pickups.bossTicket10Chance) ticket(10, 1, 'boss');
        catchShiny(data.pokemonByDex.get(due.dex), tuning.spawner.shinyRate);
        progress.itemsEquipped.push(pick(rng, data.items).id);
      }
    }
    bossBusy = Math.max(0, bossBusy - 1);
    // Aggregate ordinary defeats; roster and age-dependent tier selection match spawner.ts.
    const n = poisson(rng, (P.killsPerMapMinute / 60) * (bossBusy ? 0.25 : 1));
    kills += n;
    for (let k = 0; k < n; k++) {
      if (rng() < tuning.pickups.ticketDropRate) ticket(1, 1, 'enemy');
      if (rng() < tuning.spawner.shinyRate) {
        const tiers = roster.tiers.filter((v) => t >= v.from);
        const tier = weighted(
          rng,
          tiers,
          tiers.map((v) => v.list.length * (t - v.from > 260 ? 3 : 10)),
        );
        const mon = data.pokemonByDex.get(pick(rng, tier.list).dex);
        if (data.hasShinySprite(mon.dex)) shinies.push(mon.dex);
      }
    }
    if (thieves < 2 && --nextThief <= 0) {
      if (bossBusy) nextThief = 8;
      else {
        thieves++;
        nextThief = range(rng, E.thiefNext);
        if (rng() < E.goldThiefChance && rng() < P.thiefKillChance) ticket(10, 1, 'thief');
      }
    }
    if (eventLeft > 0) {
      eventLeft--;
      continue;
    }
    if (--nextEvent <= 0) {
      if (bossBusy) {
        nextEvent = 10;
        continue;
      }
      const event = pick(
        rng,
        ['horde', 'gold', 'lost'].filter((x) => x !== lastEvent),
      );
      lastEvent = event;
      nextEvent = range(rng, E.every);
      eventLeft = event === 'lost' ? P.rescueSeconds : E.duration;
      if (event === 'lost' && rng() < P.rescueSuccess) {
        ticket(1, 1, 'rescue');
        if (rng() < E.lostJoinChance) progress.rescued.push(pick(rng, rescuePool).dex);
      }
    }
  }
  const chests = poisson(rng, (P.chestsPerMapHour * mapS) / 3600);
  progress.chestsOpened = chests;
  for (let i = 0; i < chests; i++) {
    ticket(1, 1 + Math.floor(rng() * 3), 'chest');
    if (rng() < 0.15) ticket(10, 1, 'chest');
  }
  progress.movesEvolved = Array.from(
    { length: P.evolutionsPerRun },
    () =>
      pick(
        rng,
        data.moves.moves.filter((m) => m.evolution),
      ).id,
  );
  // Type kills are an explicit approximation for typed missions; rosters still govern catches.
  for (const type of data.types.types) progress.defeatsByType[type.id] = Math.floor(kills / 9);
  const claim = {
    durationS: runS,
    level: P.level,
    kills,
    bosses,
    coins: Math.round(P.runMinutes * 70),
    ticketsX1: x1,
    ticketsX10: x10,
    shiniesCaught: shinies,
    progress,
  };
  const stats = P.coop ? claim : capRunStats(claim, DEFAULT_ECONOMY.runCaps, runS).stats;
  source('capReduction', stats.ticketsX1 - x1 + 10 * (stats.ticketsX10 - x10));
  return {
    stats,
    sources,
    metrics: {
      runs: 1,
      mapMinutes: mapS / 60,
      kills,
      riftOpens,
      riftEntries,
      riftWins: progress.riftWins.length,
      riftShinies,
    },
  };
}

function playRun(c, runIndex) {
  const { state: s, locked, grant } = c;
  const cached = runCache.get(runIndex) ?? generateRun(s, locked.userId, runIndex);
  runCache.set(runIndex, cached);
  const { stats, sources, metrics } = cached;
  const P = profile;
  const runS = P.runMinutes * 60;
  for (const [key, n] of Object.entries(sources)) s.sources[key] = (s.sources[key] ?? 0) + n;
  for (const [key, n] of Object.entries(metrics)) s.metrics[key] = (s.metrics[key] ?? 0) + n;
  s.wallet.x1 += stats.ticketsX1;
  s.wallet.x10 += stats.ticketsX10;
  for (const dex of stats.shiniesCaught) if (P.nonGacha) grant(dex, true);
  for (const dex of stats.progress.rescued) if (P.nonGacha) grant(dex);
  for (const dex of stats.progress.legendariesDefeated) s.save.legendsBeaten[dex] = 1;
  for (const type of stats.progress.riftWins) s.save.arenasWon[type] = 1;
  for (const id of stats.progress.itemsEquipped) s.save.itemsFound[id] = 1;
  for (const id of stats.progress.movesEvolved) s.save.movesEvolved[id] = 1;
  const st = s.save.stats;
  st.runs++;
  st.groupRuns += Number(P.coop);
  st.bestTimeS = Math.max(st.bestTimeS, runS);
  st.bestLevel = Math.max(st.bestLevel, P.level);
  if (P.coop) st.bestGroupTimeS = Math.max(st.bestGroupTimeS, runS);
  st.shinies += stats.shiniesCaught.length;
  st.totalKills += stats.kills;
  st.bossesTotal += stats.bosses;
  st.coinsEarned += stats.coins;
  st.evolutions += stats.progress.movesEvolved.length;
  st.riftWins += stats.progress.riftWins.length;
  // One hour of active sessions per calendar day by default. Daily/weekly rolls are real;
  // claiming is automatic, rerolling and changing partner to chase typed missions are omitted.
  const day = Math.floor((s.hour - 1e-9) / P.hoursPerDay);
  ensureMissions(locked, { daily: `day-${day}`, weekly: `week-${Math.floor(day / 7)}` });
  advanceMissions(s.save, {
    kind: 'run',
    summary: stats,
    pokemonTypes: data.pokemonByDex.get(s.save.starter).types,
  });
  for (const kind of ['daily', 'weekly']) {
    s.save.missions[kind].missions.forEach((m, i) => {
      if (!m.claimed && m.progress >= m.goal) claimMission(locked, kind, i);
    });
  }
  checkAchievements(locked, runIndex + 1);
}

function simulateOne(pool, option, kind, trial) {
  const horizon = kind === 'pulls' ? Math.max(...pullSnapshots) : Math.max(...hourSnapshots);
  const c = collector(pool, option, `${seed}:${pool.id}:${kind}:${trial}`);
  const s = c.state;
  // Same seeds across options reduce comparison noise; histories are still independent.
  const starter =
    data.starters.starters.find((p) => data.pokemonByDex.get(p.dex).gen === pool.gen) ??
    data.starters.starters[0];
  s.save.starter = starter.dex;
  c.mark();
  if (kind === 'play') {
    c.grant(starter.dex);
    checkAchievements(c.locked, 1);
  }
  let runIndex = 0;
  while (s.completed.some((x) => x === null) || (kind === 'pulls' ? s.pulls : s.hour) < horizon) {
    if (kind === 'pulls') {
      if (s.pulls >= maxPulls) break;
      c.draw(pullStyle === 'single' ? 1 : data.gacha.cost.multiCount);
    } else {
      if (s.hour >= maxHours || s.pulls >= maxPulls) break;
      const beforeHour = s.hour,
        beforeFraction = c.fraction(),
        beforePulls = s.pulls;
      s.hour += (profile.runMinutes + profile.downtimeMinutes) / 60;
      playRun(c, runIndex++);
      // Save singles for multis by default, with no artificial fractional ×10 tickets.
      while (s.wallet.x10 > 0 || s.wallet.x1 >= (pullStyle === 'single' ? 1 : 10)) {
        if (s.wallet.x10 > 0) {
          s.wallet.x10--;
          c.draw(10);
        } else {
          const count = pullStyle === 'single' ? 1 : 10;
          s.wallet.x1 -= count;
          c.draw(count);
        }
        checkAchievements(c.locked, runIndex + 1);
      }
      for (const hour of hourSnapshots)
        if (beforeHour < hour && s.hour >= hour) {
          // Rewards arrive only at run end: sample the previous finished run for an exact cutoff.
          const atEnd = Math.abs(s.hour - hour) < 1e-9;
          s.hourFractions[hour] = atEnd ? c.fraction() : beforeFraction;
          s.pullsAtHour[hour] = atEnd ? s.pulls : beforePulls;
        }
    }
  }
  return s;
}

function summarize(pool, option, kind, runs) {
  const tier = names.map((name, i) => ({
    name,
    size: pool.byRarity.get(i + 1)?.length ?? 0,
    pulls: estimate(
      runs.map((s) => s.completed[i]),
      trials,
    ),
    ...(kind === 'play'
      ? {
          hours: estimate(
            runs.map((s) => s.completedHours[i]),
            trials,
          ),
        }
      : {}),
  }));
  const fractions = (key, snapshots) =>
    Object.fromEntries(
      snapshots.map((n) => [
        n,
        names.map((_, i) => {
          const values = runs.map((s) => s[key][n]?.[i]).filter((v) => v !== undefined);
          return values.length === trials ? average(values) : null;
        }),
      ]),
    );
  const legendaryLast =
    runs.filter(
      (s) =>
        s.completed.every((x) => x !== null) &&
        s.completed[4] >= Math.max(...s.completed.slice(0, 4)),
    ).length / trials;
  return {
    region: pool.id,
    option: option.id,
    kind,
    tier,
    legendaryLast,
    fractionAtPulls: fractions('fractions', pullSnapshots),
    ...(kind === 'play'
      ? {
          fractionAtHours: fractions('hourFractions', hourSnapshots),
          pullsAtHours: Object.fromEntries(
            hourSnapshots.map((n) => [n, average(runs.map((s) => s.pullsAtHour[n]))]),
          ),
          metricsPerHour: Object.fromEntries(
            [...new Set(runs.flatMap((s) => Object.keys(s.metrics)))].map((k) => [
              k,
              average(runs.map((s) => (s.metrics[k] ?? 0) / s.hour)),
            ]),
          ),
          sourcesPerHour: Object.fromEntries(
            [...new Set(runs.flatMap((s) => Object.keys(s.sources)))].map((k) => [
              k,
              average(runs.map((s) => (s.sources[k] ?? 0) / s.hour)),
            ]),
          ),
        }
      : {}),
    refundAtPulls: Object.fromEntries(
      pullSnapshots.map((n) => [n, average(runs.map((s) => s.refundAt[n] ?? NaN))]),
    ),
    pullsPerLegendary: sum(runs.map((s) => s.pulls)) / sum(runs.map((s) => s.legendaryDraws)),
  };
}

const results = [];
const kinds = mode === 'both' ? ['pulls', 'play'] : [mode];
for (const pool of pools) {
  const buckets = new Map(options.flatMap((o) => kinds.map((k) => [`${o.id}:${k}`, []])));
  for (let trial = 0; trial < trials; trial++) {
    runCache = new Map();
    for (const option of options)
      for (const kind of kinds) {
        buckets.get(`${option.id}:${kind}`).push(simulateOne(pool, option, kind, trial));
      }
    if ((trial + 1) % 100 === 0) console.error(`${pool.id}: ${trial + 1}/${trials} histories`);
  }
  for (const option of options)
    for (const kind of kinds) {
      const result = summarize(pool, option, kind, buckets.get(`${option.id}:${kind}`));
      results.push(result);
      console.error(
        `${pool.id} ${option.id} ${kind}: ${result.tier
          .map(
            (t) =>
              `${t.name}=${t.pulls.mean?.toFixed(0) ?? 'censored'}${t.hours ? `/${t.hours.mean?.toFixed(1)}h` : ''}`,
          )
          .join(' ')}; legendary last ${(100 * result.legendaryLast).toFixed(1)}%`,
      );
    }
}
const output = {
  seed,
  trials,
  pullStyle,
  profile,
  maxPulls,
  maxHours,
  pullSnapshots,
  hourSnapshots,
  configs: options,
  rarityNames: names,
  results,
};
if (arg('out')) writeFileSync(arg('out'), JSON.stringify(output, null, 2) + '\n');
else console.log(JSON.stringify(output, null, 2));
