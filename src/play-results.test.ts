import { describe, expect, it } from 'vitest';
import {
  markLine, scoreLines, bestFromHistory, buildResultShareText,
  nextRate, normalizeRate, loopAction, loopStart, LOOP_PREROLL,
} from './play-results';

describe('markLine', () => {
  // Same rule as the play page's Check (slotState): picks and ans are both
  // kept ascending, so equal sets compare equal element for element.
  it('marks an exact pick correct', () => {
    expect(markLine({ choices: [1, 2], ans: [1, 2] })).toBe('correct');
  });
  it('marks partial and empty picks', () => {
    expect(markLine({ choices: [1], ans: [1, 2] })).toBe('wrong');
    expect(markLine({ choices: [], ans: [1] })).toBe('blank');
  });
});

describe('scoreLines', () => {
  const result = scoreLines([
    { choices: [1], ans: [1] },
    { choices: [2], ans: [1, 2] },
    { choices: [], ans: [3] },
    { choices: [1, 2], ans: [1, 2] },
  ]);
  it('counts correct lines and percentage', () => {
    expect(result.correct).toBe(2);
    expect(result.total).toBe(4);
    expect(result.pct).toBe(50);
    expect(result.marks).toEqual(['correct', 'wrong', 'blank', 'correct']);
  });
  it('credits each singer of a correct line', () => {
    expect(result.members).toEqual([
      { id: 1, hit: 2, total: 3 },
      { id: 2, hit: 1, total: 2 },
      { id: 3, hit: 0, total: 1 },
    ]);
  });
  it('handles an empty song', () => {
    expect(scoreLines([]).pct).toBe(0);
  });
});

describe('bestFromHistory', () => {
  type Slots = [number[], number[]][];
  const songHist = [
    { date: 'd', songName: 'A', slots: [[[1], [1]], [[2], [1]]] as Slots },
    { date: 'd', songName: 'A', slots: [[[1], [1]], [[1], [1]]] as Slots },
    { date: 'd', songName: 'A', slots: [[[1], [1]]] as Slots },
  ];
  it('takes the best run at the same line count', () => {
    expect(bestFromHistory(songHist, 2)).toBe(2);
    expect(bestFromHistory(songHist, 1)).toBe(1);
  });
  it('returns null when never played at that line count', () => {
    expect(bestFromHistory(songHist, 3)).toBeNull();
    expect(bestFromHistory([], 2)).toBeNull();
  });
});

describe('buildResultShareText', () => {
  it('wraps the grid every 10 lines and flags full combo and best', () => {
    const lines = Array.from({ length: 12 }, () => ({ choices: [1], ans: [1] }));
    const text = buildResultShareText({
      brand: 'BubuDesuWho', songTitle: 'Aozora', diffLabel: 'Hard',
      result: scoreLines(lines), newBest: true, url: 'x.io/play.html#aozora',
    });
    const rows = text.split('\n');
    expect(rows[0]).toBe('BubuDesuWho · Aozora (Hard)');
    expect(rows[1]).toBe('12/12 · 100% · FULL COMBO · new best!');
    expect([...rows[3]].length).toBe(10);
    expect([...rows[4]].length).toBe(2);
    expect(rows[rows.length - 1]).toBe('x.io/play.html#aozora');
  });
  it('uses red and blank squares for misses', () => {
    const text = buildResultShareText({
      brand: 'B', songTitle: 'S', diffLabel: 'Normal', newBest: false, url: 'u',
      result: scoreLines([{ choices: [2], ans: [1] }, { choices: [], ans: [1] }]),
    });
    expect(text).toContain('\u{1F7E5}⬜');
    expect(text).not.toContain('FULL COMBO');
  });
});

describe('rates', () => {
  it('cycles 0.5 -> 0.75 -> 1 -> 0.5', () => {
    expect(nextRate(0.5)).toBe(0.75);
    expect(nextRate(0.75)).toBe(1);
    expect(nextRate(1)).toBe(0.5);
  });
  it('normalizes junk to 1x', () => {
    expect(normalizeRate(NaN)).toBe(1);
    expect(normalizeRate(3)).toBe(1);
    expect(normalizeRate(0.75)).toBe(0.75);
  });
});

describe('loopAction', () => {
  const range: [number, number] = [10, 14];
  it('restarts once playback passes the end', () => {
    expect(loopAction(12, range, false)).toBe('none');
    expect(loopAction(14.01, range, false)).toBe('restart');
  });
  it('clears when the user seeks away', () => {
    expect(loopAction(30, range, true)).toBe('clear');
    expect(loopAction(2, range, true)).toBe('clear');
  });
  it('keeps looping after its own restart seek', () => {
    expect(loopAction(loopStart(range), range, true)).toBe('none');
    expect(loopStart([0.1, 2])).toBe(0);
    expect(loopStart(range)).toBeCloseTo(10 - LOOP_PREROLL);
  });
});
