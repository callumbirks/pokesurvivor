// Regression: the spawn schedule matches legacy, measured with the cap out of the way.
//
// The reference numbers were measured in legacy itself (`legacy/` in headless Chromium with a
// faked clock, invulnerable Pikachu, every non-boss enemy removed the tick it appears so the
// 64-enemy cap never binds, bosses removed after 30 s, team-mates ±70 px from the first player).
// They are wild Pokémon spawned per minute of the run: trickle, surges, boss-fight slowdowns
// and horde bursts, but not bosses, thieves or summoned minions. See the description of the
// pull request that added this test for the measurement and the full comparison.
import { describe, expect, it } from 'vitest';
import { createSim } from '../src/index.js';

const LEGACY_PER_MINUTE = {
  1: [43, 89, 122, 110, 230, 278, 221, 399, 471, 344, 604, 690, 477, 843, 914],
  3: [83, 150, 237, 193, 430, 515, 383, 717, 861, 613, 1095, 1279, 832, 1542, 1657],
} as const;

/** Spawns per minute with every regular enemy removed as soon as it appears. */
function spawnsPerMinute(players: 1 | 3, minutes: number, seed: number): number[] {
  const sim = createSim({
    seed,
    players: [25, 4, 7].slice(0, players).map((dex, i) => ({ id: `p${i}`, dex })),
    debug: { invulnerable: true },
  });
  const s = sim.state;
  const p0 = s.players[0]!;
  const born = new Map<number, number>();
  const perMinute = Array.from({ length: minutes }, () => 0);
  while (s.time < minutes * 60) {
    for (const c of s.pendingChoices.slice()) {
      if (c.kind === 'level-up')
        sim.submitIntent(c.playerId, {
          type: 'pickCard',
          choiceId: c.id,
          cardId: c.options[0]!.id,
        });
    }
    // Standing still in a tight group, as legacy's measurement did: nobody walks into a rift.
    s.players.slice(1).forEach((p, i) => {
      p.x = p0.x + (i ? -70 : 70);
      p.y = p0.y + 40;
    });
    for (const e of s.enemies) {
      if (!e.boss || s.time - (born.get(e.id) ?? 0) >= 30) e.dead = true;
    }
    sim.step();
    for (const ev of sim.drainEvents()) {
      if (ev.type !== 'enemy-spawned') continue;
      born.set(ev.id, s.time);
      const e = s.enemies.find((x) => x.id === ev.id);
      if (ev.boss || ev.legend || e?.life != null) continue;
      perMinute[Math.min(minutes - 1, Math.floor(s.time / 60))]!++;
    }
    expect(s.arena).toBeNull();
  }
  return perMinute;
}

const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

// Tolerances cover other seeds (12 tried: solo within 3% of legacy in every 3-minute window,
// three players within 8%; legacy's own runs vary as much) and still catch a 10% change in
// density or a wrong co-op factor. Three players cost ~3× the path-field work, so they run the
// first 9 minutes (three bosses): co-op scaling is a constant factor from the first second.
const CASES = [
  { players: 1, minutes: 15, total: 0.03, window: 0.06, firstMinute: 2 },
  { players: 3, minutes: 9, total: 0.1, window: 0.15, firstMinute: 15 },
] as const;

describe('spawn schedule matches legacy (cap not binding)', () => {
  for (const { players, minutes, total, window, firstMinute } of CASES) {
    it(`${players} player${players > 1 ? 's' : ''}, first ${minutes} minutes`, () => {
      const legacy = LEGACY_PER_MINUTE[players].slice(0, minutes);
      const got = spawnsPerMinute(players, minutes, 11);
      const all = sum(got) / sum(legacy);
      expect(all, `per minute: ${got.join(', ')}`).toBeGreaterThan(1 - total);
      expect(all, `per minute: ${got.join(', ')}`).toBeLessThan(1 + total);
      // Each 3-minute window (one boss fight each, so surge timing evens out).
      for (let w = 0; w < minutes; w += 3) {
        const ratio = sum(got.slice(w, w + 3)) / sum(legacy.slice(w, w + 3));
        expect(ratio, `minutes ${w}–${w + 2}: ${got.slice(w, w + 3).join(', ')}`).toBeGreaterThan(
          1 - window,
        );
        expect(ratio, `minutes ${w}–${w + 2}: ${got.slice(w, w + 3).join(', ')}`).toBeLessThan(
          1 + window,
        );
      }
      // The first minute is the bare trickle: (1.6 + …) × 0.24 per second, ×2.5 for three.
      expect(Math.abs(got[0]! - legacy[0]!)).toBeLessThanOrEqual(firstMinute);
    }, 20_000);
  }
});
