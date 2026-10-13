import { describe, expect, it } from 'vitest';
import { bestStarters, loadGameData, personalityScores, topTrait } from '../src/index.js';

const { starters } = loadGameData();
const test = starters.personalityTest;

describe('personality test', () => {
  it('sums the points of the chosen answers', () => {
    const scores = personalityScores(
      test,
      test.map(() => 0),
    );
    expect(scores).not.toBeNull();
    const first = test[0]?.answers[0]?.points ?? {};
    for (const [trait, points] of Object.entries(first))
      expect(scores?.[trait]).toBeGreaterThanOrEqual(points);
  });

  it('rejects answers that do not fit the test', () => {
    expect(personalityScores(test, [0])).toBeNull();
    expect(
      personalityScores(
        test,
        test.map(() => 99),
      ),
    ).toBeNull();
  });

  it('breaks trait ties by the first scored, as legacy does', () => {
    expect(topTrait({ brave: 2, loyal: 3, cautious: 3 })).toBe('loyal');
    expect(topTrait({})).toBeNull();
  });

  it('weights the primary trait double when matching starters', () => {
    const best = bestStarters(starters.starters, { brave: 1, impulsive: 1 });
    // Charmander is brave/impulsive: 2 + 1 beats anything with only one of them.
    expect(best.map((s) => s.dex)).toEqual([4]);
  });
});
