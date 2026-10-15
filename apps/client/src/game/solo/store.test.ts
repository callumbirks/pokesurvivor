import { createSim, restoreSim, type Sim } from '@pokesurvivor/sim';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { indexedDbRunStore, memoryRunStore, type SavedSoloRun } from './store.js';

const loadout = { id: 'u1', dex: 4 };

/** Plays `ticks` with a fixed circling input and the first card of every choice. */
function play(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const c of sim.state.pendingChoices.slice())
      if (c.kind === 'level-up' && c.options[0])
        sim.submitIntent(c.playerId, { type: 'pickCard', choiceId: c.id, cardId: c.options[0].id });
    const a = sim.state.tick / 50;
    sim.setInput('u1', { moveX: Math.cos(a), moveY: Math.sin(a) });
    sim.step();
    sim.drainEvents();
  }
}

function saved(sim: Sim, runId = 'run-1'): SavedSoloRun {
  return {
    userId: 'u1',
    runId,
    savedAt: 1,
    seed: 42,
    loadout,
    username: 'ash',
    owned: [4],
    summary: sim.runSummaryFor('u1'),
    // What the worker posts: a structured clone of the state.
    state: structuredClone(sim.state),
  };
}

describe.each([
  ['IndexedDB', () => indexedDbRunStore(new IDBFactory())],
  ['memory', () => memoryRunStore()],
])('%s run store', (_name, makeStore) => {
  it('saves and restores a run that continues exactly like the original', async () => {
    const store = makeStore();
    // Persistence needs a live run; survival balance is measured separately.
    const sim = createSim({
      seed: 42,
      players: [loadout],
      choiceTimeoutSeconds: null,
      debug: { invulnerable: true },
    });
    play(sim, 900);
    await store.put(saved(sim));

    const back = await store.get('u1');
    expect(back?.runId).toBe('run-1');
    expect(back?.summary.durationS).toBe(30);
    const restored = restoreSim(back!.state!);
    expect(restored.hash()).toBe(sim.hash());
    play(sim, 600);
    play(restored, 600);
    expect(restored.hash()).toBe(sim.hash());
    expect(restored.runSummaryFor('u1')).toEqual(sim.runSummaryFor('u1'));
  });

  it('keeps one run per user and deletes only the run asked for', async () => {
    const store = makeStore();
    const sim = createSim({ seed: 1, players: [loadout], choiceTimeoutSeconds: null });
    await store.put(saved(sim, 'old'));
    await store.put(saved(sim, 'new'));
    expect((await store.get('u1'))?.runId).toBe('new');
    // The old run's report finishing late doesn't drop the newer run's save.
    await store.delete('u1', 'old');
    expect((await store.get('u1'))?.runId).toBe('new');
    expect(await store.get('someone-else')).toBeNull();
    await store.delete('u1', 'new');
    expect(await store.get('u1')).toBeNull();
  });
});
