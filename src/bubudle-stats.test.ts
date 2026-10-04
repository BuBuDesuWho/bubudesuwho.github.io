import { describe, expect, it } from 'vitest';
import { computeDailyStats, DatedResult } from './bubudle-stats';

function day(date: string, correct: boolean, guesses = 1, archive?: boolean): DatedResult {
  return {
    date,
    result: {
      guesses: Array.from({ length: guesses }, (_, i) => String(i + 1)),
      correct,
      songId: 's',
      range: [0, 1],
      wrongCount: correct ? guesses - 1 : guesses,
      ...(archive ? { archive } : {}),
    },
  };
}

describe('computeDailyStats', () => {
  it('is all zeros with no history', () => {
    const s = computeDailyStats([], '2026-09-27');
    expect(s).toMatchObject({ played: 0, wins: 0, winPct: 0, currentStreak: 0, maxStreak: 0, losses: 0 });
    expect(s.distribution).toEqual([0, 0, 0, 0]);
  });

  it('buckets wins by guess count and counts losses separately', () => {
    const s = computeDailyStats([
      day('2026-09-20', true, 1),
      day('2026-09-21', true, 3),
      day('2026-09-22', true, 3),
      day('2026-09-23', false, 4),
    ], '2026-09-23');
    expect(s.distribution).toEqual([1, 0, 2, 0]);
    expect(s.losses).toBe(1);
    expect(s.winPct).toBe(75);
  });

  it('keeps the current streak alive while today is unplayed', () => {
    const s = computeDailyStats([day('2026-09-25', true), day('2026-09-26', true)], '2026-09-27');
    expect(s.currentStreak).toBe(2);
  });

  it('breaks the current streak on a missed day', () => {
    const s = computeDailyStats([day('2026-09-24', true), day('2026-09-25', true)], '2026-09-27');
    expect(s.currentStreak).toBe(0);
    expect(s.maxStreak).toBe(2);
  });

  it('breaks the current streak on a loss today', () => {
    const s = computeDailyStats([day('2026-09-26', true), day('2026-09-27', false, 4)], '2026-09-27');
    expect(s.currentStreak).toBe(0);
    expect(s.maxStreak).toBe(1);
  });

  it('finds the longest run across gaps and losses, in any input order', () => {
    const s = computeDailyStats([
      day('2026-09-05', true),
      day('2026-09-01', true),
      day('2026-09-02', true),
      day('2026-09-03', true),
      day('2026-09-04', false),
      day('2026-09-07', true),
    ], '2026-09-10');
    expect(s.maxStreak).toBe(3);
  });

  it('counts a run across a month boundary', () => {
    const s = computeDailyStats([day('2026-08-31', true), day('2026-09-01', true)], '2026-09-01');
    expect(s.currentStreak).toBe(2);
    expect(s.maxStreak).toBe(2);
  });

  it('keeps archive plays out of the numbers but reports them', () => {
    const s = computeDailyStats([
      day('2026-09-25', true, 1, true),
      day('2026-09-26', true),
    ], '2026-09-27');
    expect(s.played).toBe(1);
    expect(s.currentStreak).toBe(1);
    expect(s.archivePlayed).toBe(1);
  });
});
