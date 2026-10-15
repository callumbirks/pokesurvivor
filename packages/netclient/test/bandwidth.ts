// Snapshot bandwidth per client in a 4-player late game: `pnpm --filter @pokesurvivor/netclient bandwidth`.
import { SnapshotEncoder } from '../src/snapshot.js';
import { botStep, lateGame } from './late-game.js';
import { measure } from './measure.js';

const minutes = Number(process.argv[2] ?? 18);
console.log(`4 players, ${minutes} minutes in, bots kept together (every enemy near everyone)`);
for (const [format, radius, hz] of [
  ['binary', 950, 15],
  ['binary', 950, 20],
  ['json', 950, 15],
  ['json', 950, 20],
  ['binary', 1e9, 20],
] as const) {
  const sim = lateGame(minutes);
  const s = sim.state;
  const m = measure(sim, { seconds: 30, hz, format, radius });
  console.log(
    `${format.padEnd(6)} r=${radius === 1e9 ? '∞  ' : radius} ${hz} Hz: ` +
      `${(m.bytesPerSecond / 1024).toFixed(1)} KB/s (deflated ${(m.deflatedPerSecond / 1024).toFixed(1)}), ` +
      `events+choices as JSON ${(m.jsonPerSecond / 1024).toFixed(1)} KB/s, max frame ${m.maxFrame} B, full frame ${m.fullFrame} B ` +
      `[enemies ${s.enemies.length}, projectiles ${s.projectiles.length}, pickups ${s.pickups.length}]`,
  );
}

// Spectating: a downed viewer far from the crowd switches its interest area onto a teammate in it
// (every enemy around them enters at once), then back.
{
  const sim = lateGame(minutes);
  const s = sim.state;
  const [target, me] = [s.players[0]!, s.players[1]!];
  me.dead = true;
  const enc = new SnapshotEncoder({ viewerId: me.id });
  let seq = 0;
  const frame = () => {
    botStep(sim);
    me.x = target.x + 4000;
    me.y = target.y + 4000;
    return (enc.encode(s, sim.drainEvents(), ++seq, 0) as Uint8Array).length;
  };
  const full = frame();
  for (let i = 0; i < 20; i++) frame();
  enc.focusId = target.id;
  const switched = frame();
  const after = Array.from({ length: 20 }, frame);
  enc.focusId = null;
  const back = frame();
  console.log(
    `spectate switch: ${switched} B (full frame alone ${full} B), next 20 frames ≤ ${Math.max(...after)} B, ` +
      `switch back ${back} B [enemies ${s.enemies.length}]`,
  );
}
