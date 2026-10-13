// The sim produces the protocol's run result (`packages/protocol` RunSummary) that the server
// credits: check a finished bot run against the same rules as `POST /api/runs`.
import { POKEMON_TYPES } from '@pokesurvivor/data';
import type { RunSummary } from '@pokesurvivor/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { simData } from '../src/data.js';
import { createSim } from '../src/index.js';
import { botStep } from './bots.js';

const d = simData();
const count = z.number().int().nonnegative();
const dex = z
  .number()
  .int()
  .refine((n) => d.game.pokemonByDex.has(n), 'unknown dex');
const type = z.enum(POKEMON_TYPES);

/** Mirrors apps/server/src/runs/routes.ts `finishBody` (minus `runId`), strict. */
const RunSummarySchema = z.strictObject({
  durationS: count,
  level: count,
  kills: count,
  bosses: count,
  coins: count,
  ticketsX1: count,
  ticketsX10: count,
  shiniesCaught: z.array(dex),
  progress: z.strictObject({
    defeatsByType: z.partialRecord(type, count),
    chestsOpened: count,
    itemsEquipped: z.array(z.string().refine((id) => d.game.itemById.has(id), 'unknown item')),
    movesEvolved: z.array(z.string().refine((id) => d.game.moveById.has(id), 'unknown move')),
    riftWins: z.array(type),
    legendariesDefeated: z.array(dex),
    rescued: z.array(dex),
  }),
}) satisfies z.ZodType<RunSummary>;

describe('protocol run summaries', () => {
  it('a finished bot run yields valid, consistent summaries for every player', () => {
    const sim = createSim({
      seed: 77,
      players: [
        { id: 'a', dex: 6, upgrades: { coins: 8 } },
        { id: 'b', dex: 131 },
      ],
    });
    let typeHits = 0;
    while (!sim.ended && sim.state.time < 30 * 60) {
      botStep(sim);
      for (const e of sim.drainEvents()) {
        if (e.type === 'progress' && e.event === 'defeat')
          typeHits += (e.data.types as string[]).length;
      }
    }
    expect(sim.ended).toBe(true);
    const full = sim.summary();
    for (const id of ['a', 'b']) {
      const run = sim.runSummaryFor(id);
      expect(() => RunSummarySchema.parse(run)).not.toThrow();
      const p = full.players.find((x) => x.playerId === id)!;
      expect(run.coins).toBe(p.rewardCoins);
      expect(run.durationS).toBe(Math.floor(full.time));
      expect(run.kills).toBeGreaterThan(0);
      // Each defeat counts once per type of the enemy: 1–2 per kill.
      const sum = Object.values(run.progress.defeatsByType).reduce<number>(
        (a, n) => a + (n ?? 0),
        0,
      );
      expect(sum).toBe(typeHits);
      expect(sum).toBeGreaterThanOrEqual(run.kills);
      expect(sum).toBeLessThanOrEqual(run.kills * 2);
      expect(p.progress.defeats).toBe(run.kills);
      expect(run.bosses).toBeLessThanOrEqual(run.kills);
    }
    // Fortune upgrade: same run, more coins.
    expect(sim.runSummaryFor('a').coins).toBeGreaterThan(sim.runSummaryFor('b').coins);
  });
});
