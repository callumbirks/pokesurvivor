import type { PersonalityQuestion, Starter } from './schemas/index.js';

/**
 * Points per trait from the answers to the personality test: `answers[i]` is the index of the
 * answer chosen for question `i`. Returns null if the answers don't fit the test.
 */
export function personalityScores(
  test: readonly PersonalityQuestion[],
  answers: readonly number[],
): Record<string, number> | null {
  if (answers.length !== test.length) return null;
  const scores: Record<string, number> = {};
  for (const [i, question] of test.entries()) {
    const answer = question.answers[answers[i] ?? -1];
    if (!answer) return null;
    for (const [trait, points] of Object.entries(answer.points))
      scores[trait] = (scores[trait] ?? 0) + points;
  }
  return scores;
}

/** The trait with the most points; ties go to the one scored first (original `personalityResult`). */
export function topTrait(scores: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [trait, points] of Object.entries(scores))
    if (best === null || points > (scores[best] ?? 0)) best = trait;
  return best;
}

/**
 * The starters that best match the scores: the primary trait's points count double. Legacy
 * picks one of the tied starters at random and lets the player accept it or choose any other.
 */
export function bestStarters(
  starters: readonly Starter[],
  scores: Record<string, number>,
): Starter[] {
  let best: Starter[] = [];
  let bestScore = -1;
  for (const s of starters) {
    const score = (scores[s.traits[0]] ?? 0) * 2 + (scores[s.traits[1]] ?? 0);
    if (score > bestScore) {
      bestScore = score;
      best = [s];
    } else if (score === bestScore) best.push(s);
  }
  return best;
}
