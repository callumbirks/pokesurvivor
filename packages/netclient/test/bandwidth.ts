// Snapshot bandwidth per client in a 4-player late game: `pnpm --filter @pokesurvivor/netclient bandwidth`.
import { lateGame } from './late-game.js';
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
