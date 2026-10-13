// Measures "flying" entities: runs a sim through the real snapshot codec and buffer, renders the
// interpolated view at 60 fps with network jitter, and logs every entity that moves further in
// one rendered frame than anything can legitimately move, with what the sim did to it.
//   pnpm --filter @pokesurvivor/netclient exec tsx test/jumps.ts [players] [minutes] [seed] [--no-snap]
import { TICK_HZ, TICK_MS, createSim, type Sim } from '@pokesurvivor/sim';
import { SnapshotBuffer, interpolateList, maxStep } from '../src/buffer.js';
import { firstOption } from '../src/choices.js';
import { SnapshotDecoder, SnapshotEncoder } from '../src/snapshot.js';

/** An entity drawn flying: faster than anything moves, for 2+ rendered frames in a row. */
export interface Jump {
  kind: 'enemy' | 'projectile' | 'pickup' | 'player';
  id: number | string;
  /** Distance moved in one rendered frame. */
  d: number;
  /** What the sim did between the two snapshots it was drawn between. */
  cause: string;
}

/** Bots that run in long straight lines (players far apart: stragglers come back ahead). */
function step(sim: Sim, wander: boolean): void {
  const s = sim.state;
  for (const c of s.pendingChoices.slice()) {
    const intent = firstOption(c);
    if (intent) sim.submitIntent(c.playerId, intent);
  }
  s.players.forEach((p, i) => {
    const a = wander ? Math.floor(s.tick / 240 + i * 1.3) * 2.1 + i : (s.tick / 900) * Math.PI * 2;
    sim.setInput(p.id, { moveX: Math.cos(a), moveY: Math.sin(a) });
  });
  sim.step();
}

export function measureJumps(opts: {
  players: number;
  seconds: number;
  seed: number;
  snapshotHz?: number;
  /** Snap across jumps (the fix); false: the plain lerp, to measure the bug. */
  snap?: boolean;
}): { jumps: Jump[]; frames: number; simTeleports: number } {
  const sim = createSim({
    seed: opts.seed,
    players: Array.from({ length: opts.players }, (_, i) => ({
      id: `p${i}`,
      dex: [25, 4, 7, 1][i]!,
    })),
    debug: { invulnerable: true },
  });
  const viewer = 'p0';
  const enc = new SnapshotEncoder({ viewerId: viewer });
  const dec = new SnapshotDecoder(sim.state.players.map((p) => p.id));
  const buffer = new SnapshotBuffer();
  const hz = opts.snapshotHz ?? 20;
  // Per tick, where the sim put each enemy, and why it jumped (tagged from its state).
  const simPos = new Map<number, { x: number; y: number; lagT: number }>();
  const causeOf = new Map<string, string>();
  const teleportTicks = new Map<number, number[]>();
  let simTeleports = 0;
  const arrivals: { at: number; data: Uint8Array }[] = [];
  let acc = 0;
  let seq = 0;
  let jitterSeed = opts.seed;
  const rand = () => (jitterSeed = (jitterSeed * 16807) % 2147483647) / 2147483647;
  const ticks = Math.round(opts.seconds * TICK_HZ);
  for (let t = 0; t < ticks; t++) {
    step(sim, opts.players > 1);
    const events = sim.drainEvents();
    for (const e of sim.state.enemies) {
      const before = simPos.get(e.id);
      // Faster than any enemy walks, dashes or leaps in one tick: the sim moved it.
      if (before && Math.hypot(e.x - before.x, e.y - before.y) > 60) {
        simTeleports++;
        const list = teleportTicks.get(e.id) ?? [];
        list.push(sim.state.tick);
        teleportTicks.set(e.id, list);
        const why =
          before.lagT > 0 && e.lagT === 0
            ? 'straggler sent ahead of a player'
            : events.some((x) => x.type === 'arena-entered' || x.type === 'arena-left')
              ? 'arena enter/leave'
              : 'other sim move';
        causeOf.set(`${e.id}:${sim.state.tick}`, why);
      }
      simPos.set(e.id, { x: e.x, y: e.y, lagT: e.lagT });
    }
    acc += hz;
    if (acc >= TICK_HZ) {
      acc -= TICK_HZ;
      const data = enc.encode(sim.state, events, ++seq, 0) as Uint8Array;
      // Sent at the tick, arrives 40–90 ms later (jitter, in order).
      const at = Math.max(arrivals.at(-1)?.at ?? 0, sim.state.tick * TICK_MS + 40 + rand() * 50);
      arrivals.push({ at, data });
    }
  }
  // The client: frames at 60 fps; snapshots pushed as they arrive.
  const jumps: Jump[] = [];
  const prev = new Map<string, { x: number; y: number; fast: number }>();
  let next = 0;
  let frames = 0;
  const end = arrivals.at(-1)!.at;
  for (let now = arrivals[0]!.at; now < end; now += 1000 / 60) {
    while (arrivals[next] && arrivals[next]!.at <= now) {
      buffer.push(dec.decode(arrivals[next]!.data), arrivals[next]!.at);
      next++;
    }
    const sample = buffer.sample(now);
    if (!sample) continue;
    frames++;
    const { from, to, alpha } = sample;
    const limit = opts.snap === false ? Infinity : maxStep(to.tick - from.tick);
    const v = {
      players: interpolateList(from.players, to.players, alpha, [], limit),
      enemies: interpolateList(from.enemies, to.enemies, alpha, [], limit),
      projectiles: interpolateList(from.projectiles, to.projectiles, alpha, [], limit),
    };
    const pickups = interpolateList(from.pickups, to.pickups, alpha, [], limit);
    const seen = new Set<string>();
    const check = (
      kind: Jump['kind'],
      id: number | string,
      x: number,
      y: number,
      limit: number,
    ) => {
      const key = `${kind}:${id}`;
      seen.add(key);
      const p = prev.get(key);
      const d = p ? Math.hypot(x - p.x, y - p.y) : 0;
      // A flight: faster than possible for 2+ frames in a row, so it's drawn at positions in
      // between (a snap is one frame: there, then here).
      const fast = d > limit ? (p?.fast ?? 0) + 1 : 0;
      prev.set(key, { x, y, fast });
      if (fast !== 2) return;
      let cause = 'unknown';
      if (kind === 'enemy') {
        const tps = teleportTicks.get(id as number) ?? [];
        const t = tps.find((x) => x > sample.from.tick - 3 && x <= sample.to.tick + 3);
        if (t !== undefined) cause = causeOf.get(`${id}:${t}`) ?? 'sim moved it';
      }
      jumps.push({ kind, id, d: Math.round(d), cause });
    };
    // Per rendered frame (1/60 s): nothing legit moves 40+ units (2400 u/s) between two frames.
    for (const e of v.enemies) check('enemy', e.id, e.x, e.y, 40);
    for (const p of v.projectiles) if (!p.orb) check('projectile', p.id, p.x, p.y, 40);
    for (const p of pickups) check('pickup', p.id, p.x, p.y, 40);
    for (const p of v.players) check('player', p.id, p.x, p.y, 40);
    for (const k of prev.keys()) if (!seen.has(k)) prev.delete(k);
  }
  return { jumps, frames, simTeleports };
}

if (process.argv[1]?.endsWith('jumps.ts')) {
  const args = process.argv.slice(2).filter((a) => /^[0-9]/.test(a));
  const [players = '2', minutes = '6', seed = '7'] = args;
  const snap = !process.argv.includes('--no-snap');
  const r = measureJumps({ players: +players, seconds: +minutes * 60, seed: +seed, snap });
  const by = new Map<string, Jump[]>();
  for (const j of r.jumps) {
    const k = `${j.kind}: ${j.cause}`;
    by.set(k, [...(by.get(k) ?? []), j]);
  }
  console.log(`${r.frames} frames, ${r.simTeleports} enemy moves > 60 units in one sim tick`);
  for (const [k, list] of by)
    console.log(
      `${k}: ${list.length} flights, median ${list.map((j) => j.d).sort((a, b) => a - b)[list.length >> 1]} units, max ${Math.max(...list.map((j) => j.d))}`,
    );
}
