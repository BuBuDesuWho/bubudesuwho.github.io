import { describe, expect, it } from 'vitest';
import { walkRotation, lineKey } from './bubudle-rotation';
import { shiftDate } from './bubudle-daily';

interface Line { songId: string; range: [number, number]; }

const poolOf = (n: number): Line[] =>
  Array.from({ length: n }, (_, i) => ({ songId: `song-${i}`, range: [i, i + 1] as [number, number] }));

const keyOf = (l: Line) => lineKey(l.songId, l.range);

/** Draw `days` consecutive days, carrying the rotation state forward. */
function draw(pool: Line[], days: number, scope = 'mode:anime', start = '2026-08-26') {
  const used = new Set<string>();
  const picks: Line[] = [];
  let cycle = 0;
  for (let i = 0; i < days; i++) {
    const date = shiftDate(start, i);
    const r = walkRotation(pool, keyOf, scope, used, cycle, date, date);
    cycle = r.cycle;
    picks.push(r.pick!);
  }
  return { picks, cycle, used };
}

describe('walkRotation', () => {
  it('never repeats a line within a cycle', () => {
    const pool = poolOf(50);
    const { picks } = draw(pool, 50);
    expect(new Set(picks.map(keyOf)).size).toBe(50);
  });

  it('uses every line exactly once per cycle', () => {
    const pool = poolOf(30);
    const { picks } = draw(pool, 30);
    expect(new Set(picks.map(keyOf))).toEqual(new Set(pool.map(keyOf)));
  });

  it('starts a new cycle once the pool is exhausted', () => {
    const pool = poolOf(10);
    const { picks, cycle } = draw(pool, 25);
    expect(cycle).toBe(2);
    // Each complete cycle is its own full permutation.
    expect(new Set(picks.slice(0, 10).map(keyOf)).size).toBe(10);
    expect(new Set(picks.slice(10, 20).map(keyOf)).size).toBe(10);
  });

  it('is deterministic for the same date and scope', () => {
    const pool = poolOf(40);
    expect(draw(pool, 15).picks.map(keyOf)).toEqual(draw(pool, 15).picks.map(keyOf));
  });

  it('gives different scopes different orderings', () => {
    const pool = poolOf(40);
    const a = draw(pool, 10, 'mode:anime').picks.map(keyOf);
    const b = draw(pool, 10, 'group:aqours').picks.map(keyOf);
    expect(a).not.toEqual(b);
  });

  it('walking a date range in one call matches walking it day by day', () => {
    const pool = poolOf(40);
    const stepwise = draw(pool, 12).picks.map(keyOf);
    const oneShot = walkRotation(pool, keyOf, 'mode:anime', new Set(), 0,
      '2026-08-26', shiftDate('2026-08-26', 11));
    expect(keyOf(oneShot.pick!)).toBe(stepwise[stepwise.length - 1]);
  });

  it('excludes lines already used, so a resumed walk skips them', () => {
    const pool = poolOf(20);
    const used = new Set(pool.slice(0, 19).map(keyOf));   // only one line left
    const r = walkRotation(pool, keyOf, 'mode:anime', used, 0, '2026-08-26', '2026-08-26');
    expect(keyOf(r.pick!)).toBe(keyOf(pool[19]));
    expect(r.cycle).toBe(0);
  });

  it('picks up new lines added to the pool mid-cycle', () => {
    const pool = poolOf(20);
    const used = new Set(pool.map(keyOf));   // whole original pool consumed
    const grown = [...pool, { songId: 'new-song', range: [99, 100] as [number, number] }];
    const r = walkRotation(grown, keyOf, 'mode:anime', used, 0, '2026-08-26', '2026-08-26');
    // The one unused line wins outright — no reset needed.
    expect(keyOf(r.pick!)).toBe('new-song|99|100');
    expect(r.cycle).toBe(0);
  });

  it('returns null for an empty pool rather than throwing', () => {
    const r = walkRotation<Line>([], keyOf, 'mode:anime', new Set(), 0, '2026-08-26', '2026-08-26');
    expect(r.pick).toBeNull();
  });
});

describe('lineKey', () => {
  it('distinguishes two lines of the same song', () => {
    expect(lineKey('a', [1, 2])).not.toBe(lineKey('a', [1, 3]));
  });

  it('distinguishes the same timings in different songs', () => {
    expect(lineKey('a', [1, 2])).not.toBe(lineKey('b', [1, 2]));
  });
});
