// No-repeat rotation for the daily pick.
//
// The original pick was `seed(scopeKey|date) % poolSize` — an independent draw
// every day with no memory of the ones before it, so lines recur by chance.
// That's the birthday paradox, not a bug: ~1 repeat per 123 days in the 9109-line
// All pool, and several a year in the 1600–3700-line group pools. 2026-08-08 and
// 2026-08-09 drew the same line that way.
//
// Instead each day draws from the lines *not yet used this cycle*; when every
// line has been used the cycle resets and the whole pool is in play again.
//
// Why exclusion rather than a shuffled list indexed by day number: a fixed
// permutation only holds while the pool is frozen. Adding one song renumbers
// every position after it, so every future day changes and a line already served
// can come back. Excluding what's been used survives the library growing, and
// growing is what this library does.

import { seedFromString, shiftDate } from './bubudle-daily';

/** Identity for a lyric line that survives the pool being rebuilt. */
export function lineKey(songId: string, range: readonly number[]): string {
  return `${songId}|${range[0]}|${range[1]}`;
}

export interface RotationState<T> {
  /** The pick for the requested date, or null if the pool is empty. */
  pick: T | null;
  /** Lines used so far in the cycle, after the walk. */
  used: Set<string>;
  /** How many times the pool has been exhausted and reset. */
  cycle: number;
}

/**
 * Walk the rotation from `from` to `to` inclusive, returning the pick for `to`.
 *
 * Days are walked rather than jumped because each pick depends on everything
 * drawn before it. In practice the walk is 0–1 days: the manifest records every
 * past day, so only dates it hasn't caught up to yet are simulated.
 */
export function walkRotation<T>(
  pool: T[],
  keyOf: (item: T) => string,
  scopeKey: string,
  used: Set<string>,
  cycle: number,
  from: string,
  to: string,
): RotationState<T> {
  if (pool.length === 0) return { pick: null, used, cycle };

  let pick: T | null = null;
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    let remaining = pool.filter((item) => !used.has(keyOf(item)));
    if (remaining.length === 0) {
      // Every line has had its turn — start the next cycle.
      used.clear();
      cycle += 1;
      remaining = pool;
    }
    pick = remaining[seedFromString(`${scopeKey}|${date}`) % remaining.length];
    used.add(keyOf(pick));
  }
  return { pick, used, cycle };
}
