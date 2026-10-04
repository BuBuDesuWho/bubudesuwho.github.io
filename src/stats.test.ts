import { describe, expect, it } from 'vitest';
import { aggregateWhosingsTotals } from './stats';
import type { WhosingsResults, WhosingsRun } from './storage';

function run(over: Partial<WhosingsRun>): WhosingsRun {
  return { correct: 0, attempted: 0, total: 0, partial: false, diff: 0, date: '2026-01-01T00:00:00.000Z', ...over };
}

describe('aggregateWhosingsTotals', () => {
  it('is zeroed with no results', () => {
    expect(aggregateWhosingsTotals({})).toEqual({ songsPlayed: 0, linesCorrect: 0, linesAttempted: 0 });
  });

  it('sums each song\'s last run only, ignoring best', () => {
    const results: WhosingsResults = {
      songA: { last: run({ correct: 3, attempted: 4 }), best: run({ correct: 5, attempted: 5 }) },
      songB: { last: run({ correct: 1, attempted: 2 }) },
    };
    expect(aggregateWhosingsTotals(results)).toEqual({ songsPlayed: 2, linesCorrect: 4, linesAttempted: 6 });
  });
});
