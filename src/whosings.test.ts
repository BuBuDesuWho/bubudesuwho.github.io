import { describe, expect, it, beforeEach } from 'vitest';
import { preprocessSong } from './config';
import {
  buildLines, lowestDiff, revealHolds, revealLines, activeLineAt, laneForKey, GuessSession, type WsLine,
  linePoints, maxScore, runStats, rankThresholds, rankFor, BASE_POINTS,
  sameTimeGroups, landingsBetween, isFullCombo, FULL_COMBO_MIN, type RevealHold,
  memberStats, countdownStep, accuracyPct, type LineResult,
} from './whosings';
import { saveWhosingsRun, loadWhosingsResults, isBetterWhosingsRun, type WhosingsRun } from './storage';
import { parseSettings, clampOffset, saveSettings, loadSettings, OFFSET_LIMIT } from './whosings-settings';
import type { SongConfig } from './types';

function song(lines: SongConfig['lines'], extra: Partial<SongConfig> = {}) {
  return preprocessSong({ name: 'T', id: 't', group: 'aqours', ogg: 'sound/t.ogg', lines, ...extra });
}

describe('buildLines', () => {
  it('uses the quiz slots: full-cast lines dropped, same-singer runs combined', () => {
    const s = song([
      { lyric: 'solo a', range: [0, 1], ans: [1] },
      { lyric: 'solo b', range: [1, 2], ans: [1] },
      { lyric: 'everyone', range: [2, 3], ans: [1, 2, 3] },
      { lyric: 'duet', range: [3, 4], ans: [3, 2] },
    ]);
    const lines = buildLines(s, 3);
    expect(lines.map((l) => [l.start, l.end, l.ans])).toEqual([
      [0, 2, [1]],
      [3, 4, [2, 3]],
    ]);
    expect(lines[0].lyric).toBe('solo a / solo b');
  });

  it('keeps slots at or below the chosen difficulty', () => {
    const s = song([
      { lyric: 'easy', range: [0, 1], ans: [1], diff: 1 },
      { lyric: 'hard', range: [2, 3], ans: [2], diff: 3 },
      { lyric: 'other', range: [4, 5], ans: [3], diff: 1 },
    ]);
    expect(buildLines(s, 1).map((l) => l.lyric)).toEqual(['easy', 'other']);
    expect(buildLines(s, 3)).toHaveLength(3);
    expect(lowestDiff(s)).toBe(1);
  });
});

describe('revealHolds', () => {
  it('includes full-cast lines, one hold per singer', () => {
    const s = song([
      { lyric: 'a', range: [0, 2], ans: [1] },
      { lyric: 'all', range: [2, 4], ans: [1, 2] },
    ]);
    const holds = revealHolds(s);
    expect(holds.filter((h) => h.start >= 2).map((h) => h.member).sort()).toEqual([1, 2]);
  });

  it('never overlaps two holds on one member', () => {
    const s = song([
      { lyric: 'a', range: [0, 2], ans: [1] },
      { lyric: 'b', range: [1.5, 3], ans: [1, 2] },
    ]);
    const mine = revealHolds(s).filter((h) => h.member === 1);
    expect(mine).toHaveLength(2);
    expect(mine[1].start).toBeGreaterThan(mine[0].end);
  });
});

const L: WsLine[] = [
  { start: 1, end: 3, ans: [1], lyric: 'one' },
  { start: 3, end: 5, ans: [2, 3], lyric: 'two' },
  { start: 8, end: 10, ans: [2], lyric: 'three' },
];

function play(s: GuessSession, from: number, to: number) {
  for (let t = from; t <= to + 1e-9; t += 0.1) s.update(+t.toFixed(3));
}

describe('GuessSession', () => {
  it('scores exact matches right, anything else wrong, and no pick as none', () => {
    const s = new GuessSession(L);
    play(s, 0, 1.5);
    s.toggle(1, 1.5);
    play(s, 1.5, 3.5);
    s.toggle(2, 3.5);
    play(s, 3.5, 10.5);
    expect([s.result(0), s.result(1), s.result(2)]).toEqual(['right', 'wrong', 'none']);
    expect(s.tally()).toEqual({ right: 1, guessed: 2, total: 3 });
  });

  it('lets a second click take a member back off', () => {
    const s = new GuessSession(L);
    play(s, 0, 1.5);
    s.toggle(1, 1.5);
    s.toggle(2, 1.6);
    s.toggle(2, 1.7);
    play(s, 1.5, 3.2);
    expect(s.result(0)).toBe('right');
  });

  it('counts a click just before a line for that line', () => {
    const s = new GuessSession(L);
    play(s, 0, 0.8);
    s.toggle(1, 0.8); // within GRACE of the 1s start
    play(s, 0.8, 3.2);
    expect(s.result(0)).toBe('right');
  });

  it('carries picks made between lines to the next line, lit meanwhile', () => {
    const s = new GuessSession(L);
    play(s, 0, 6);
    s.toggle(2, 6);
    expect([...s.picksAt(6)]).toEqual([2]);
    play(s, 6, 10.5);
    expect(s.result(2)).toBe('right');
    expect(s.picksAt(11).size).toBe(0);
  });

  it("doesn't overwrite a line's own picks with gap picks", () => {
    const s = new GuessSession([{ start: 1, end: 2, ans: [1], lyric: '' }]);
    s.toggle(3, 0.2); // gap pick
    s.toggle(1, 0.9); // grace window: already this line's own guess
    play(s, 0.9, 2.2);
    expect(s.result(0)).toBe('right');
  });

  it("doesn't score lines skipped by a seek, and marks the run partial", () => {
    const s = new GuessSession(L);
    play(s, 0, 0.5);
    s.seek(6);
    play(s, 6, 10.5);
    expect(s.result(0)).toBeNull();
    expect(s.result(1)).toBeNull();
    expect(s.tally().total).toBe(1);
    expect(s.seeked).toBe(true);
  });

  it('gives lines a fresh chance after seeking back', () => {
    const s = new GuessSession(L);
    play(s, 0, 1.5);
    s.toggle(2, 1.5);
    play(s, 1.5, 3.2);
    expect(s.result(0)).toBe('wrong');
    s.seek(0.5);
    play(s, 0.5, 1.5);
    s.toggle(1, 1.5);
    play(s, 1.5, 3.2);
    expect(s.result(0)).toBe('right');
  });

  it('starting partway in skips earlier lines', () => {
    const s = new GuessSession(L, 4);
    play(s, 4, 10.5);
    expect(s.result(0)).toBeNull();
    expect(s.result(1)).toBeNull();
    expect(s.result(2)).toBe('none');
    expect(s.seeked).toBe(true);
  });
});

describe('score and combo', () => {
  it('ramps the combo bonus and then caps it', () => {
    expect(linePoints(1)).toBe(BASE_POINTS);
    expect(linePoints(2)).toBeGreaterThan(linePoints(1));
    expect(linePoints(11)).toBe(linePoints(50));
    expect(maxScore(0)).toBe(0);
    expect(maxScore(3)).toBe(linePoints(1) + linePoints(2) + linePoints(3));
  });

  it('breaks the combo on a wrong or unguessed line, not on unreached ones', () => {
    expect(runStats(['right', 'right', 'wrong', 'right'])).toEqual({
      score: linePoints(1) + linePoints(2) + linePoints(1), combo: 1, maxCombo: 2,
    });
    expect(runStats(['right', 'none', 'right']).combo).toBe(1);
    expect(runStats(['right', null, 'right', null]).combo).toBe(2);
    expect(runStats([null, null])).toEqual({ score: 0, combo: 0, maxCombo: 0 });
  });

  it('scores a perfect run at exactly the max', () => {
    expect(runStats(['right', 'right', 'right', 'right']).score).toBe(maxScore(4));
  });

  it('places C < B < A < S under the max and ranks against them', () => {
    const max = maxScore(20);
    const th = rankThresholds(max);
    expect(th.map((x) => x.rank)).toEqual(['C', 'B', 'A', 'S']);
    for (let i = 1; i < th.length; i++) expect(th[i].score).toBeGreaterThan(th[i - 1].score);
    expect(th[3].score).toBeLessThan(max);
    expect(rankFor(0, max)).toBeNull();
    expect(rankFor(th[1].score, max)).toBe('B');
    expect(rankFor(max, max)).toBe('S');
    expect(rankFor(0, 0)).toBeNull();
  });
});

describe('GuessSession judgements', () => {
  it('reports each line once, as it ends', () => {
    const s = new GuessSession(L);
    const seen: number[] = [];
    for (let t = 0; t <= 10.5 + 1e-9; t += 0.1) seen.push(...s.update(+t.toFixed(3)));
    expect(seen).toEqual([0, 1, 2]);
  });

  it('keeps score and combo in step with results, including after seeks', () => {
    const s = new GuessSession(L);
    play(s, 0, 1.5);
    s.toggle(1, 1.5);
    play(s, 1.5, 3.5);
    s.toggle(2, 3.5);
    s.toggle(3, 3.6);
    play(s, 3.6, 5.2);
    expect(s.runStats()).toEqual({ score: linePoints(1) + linePoints(2), combo: 2, maxCombo: 2 });
    expect([...s.guessOf(1)].sort()).toEqual([2, 3]);

    // seeking back wipes line 1's result, and the combo with it
    s.seek(3.5);
    expect(s.runStats()).toEqual({ score: linePoints(1), combo: 1, maxCombo: 1 });
  });

  it("doesn't judge lines a forward seek jumps over", () => {
    const s = new GuessSession(L);
    play(s, 0, 0.5);
    s.seek(9);
    const seen: number[] = [];
    for (let t = 9; t <= 10.5 + 1e-9; t += 0.1) seen.push(...s.update(+t.toFixed(3)));
    expect(seen).toEqual([]);
    expect(s.runStats().combo).toBe(0);
  });
});

describe('full combo', () => {
  it('needs every judged line right and enough of them', () => {
    expect(isFullCombo(['right', 'right', 'right'])).toBe(true);
    expect(isFullCombo(['right', 'right', 'wrong'])).toBe(false);
    expect(isFullCombo(['right', 'none', 'right', 'right'])).toBe(false);
    expect(isFullCombo(['right', 'right'])).toBe(false);
    expect(isFullCombo([])).toBe(false);
    expect(isFullCombo([null, null])).toBe(false);
    expect(isFullCombo(['right'], 0)).toBe(true);
    expect(FULL_COMBO_MIN).toBe(3);
  });

  it('ignores lines playback never reached', () => {
    expect(isFullCombo([null, 'right', 'right', null, 'right'])).toBe(true);
  });

  it('follows the session, including a seek back that clears a miss', () => {
    const lines: WsLine[] = [0, 1, 2].map((k) => ({ start: 1 + k * 2, end: 2.5 + k * 2, ans: [1], lyric: '' }));
    const s = new GuessSession(lines);
    for (let k = 0; k < 3; k++) {
      play(s, k * 2, 1.2 + k * 2);
      if (k !== 2) s.toggle(1, 1.2 + k * 2);
      else s.toggle(2, 1.2 + k * 2);
    }
    play(s, 5.2, 7);
    expect(s.fullCombo()).toBe(false);
    // back to just before the last line's cue, so it's played again
    s.seek(4.5);
    play(s, 4.5, 5.2);
    s.toggle(1, 5.2);
    play(s, 5.2, 7);
    expect(s.fullCombo()).toBe(true);
  });
});

describe('sameTimeGroups', () => {
  const h = (start: number, member: number): RevealHold => ({ start, end: start + 1, member });

  it('links different members landing within the window, in member order', () => {
    const holds = [h(1, 3), h(1.03, 1), h(2, 2), h(3, 1), h(3, 2), h(3.04, 5)];
    expect(sameTimeGroups(holds)).toEqual([[1, 0], [3, 4, 5]]);
  });

  it('leaves lone notes and notes just past the window alone', () => {
    expect(sameTimeGroups([h(1, 1), h(1.2, 2), h(5, 3)])).toEqual([]);
    expect(sameTimeGroups([])).toEqual([]);
  });

  it('never links a member to itself', () => {
    expect(sameTimeGroups([h(1, 1), h(1.01, 1)])).toEqual([]);
  });
});

describe('landingsBetween', () => {
  const holds: RevealHold[] = [1, 2, 2, 4].map((start, k) => ({ start, end: start + 1, member: k }));

  it('finds starts in (from, to] and reuses the out array', () => {
    const out: number[] = [99];
    expect(landingsBetween(holds, 1, 2, out)).toBe(out);
    expect(out).toEqual([1, 2]);
    expect(landingsBetween(holds, 0.5, 1)).toEqual([0]);
    expect(landingsBetween(holds, 2, 3.9)).toEqual([]);
    expect(landingsBetween(holds, -Infinity, 10)).toEqual([0, 1, 2, 3]);
  });
});

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
}

describe('whosings results storage', () => {
  beforeEach(installLocalStorage);
  const run = (correct: number, partial = false): WhosingsRun =>
    ({ correct, attempted: 10, total: 10, partial, diff: 1, date: '2026-09-27' });

  it('keeps the latest run and the best full run', () => {
    saveWhosingsRun('s', run(5));
    saveWhosingsRun('s', run(3));
    expect(loadWhosingsResults().s.last.correct).toBe(3);
    expect(loadWhosingsResults().s.best?.correct).toBe(5);
  });

  it("doesn't let a partial run become the best", () => {
    saveWhosingsRun('s', run(9, true));
    expect(loadWhosingsResults().s.best).toBeUndefined();
    saveWhosingsRun('s', run(4));
    saveWhosingsRun('s', run(9, true));
    expect(loadWhosingsResults().s.best?.correct).toBe(4);
  });

  it('breaks a tie on right lines by score', () => {
    const scored = (correct: number, score?: number): WhosingsRun => ({ ...run(correct), score });
    expect(isBetterWhosingsRun(scored(5, 900), scored(5, 800))).toBe(true);
    expect(isBetterWhosingsRun(scored(5, 700), scored(5, 800))).toBe(false);
    expect(isBetterWhosingsRun(scored(5, 100), scored(5))).toBe(true);
    expect(isBetterWhosingsRun(scored(4, 9999), scored(5, 1))).toBe(false);
    saveWhosingsRun('s', scored(5, 800));
    saveWhosingsRun('s', scored(5, 900));
    expect(loadWhosingsResults().s.best?.score).toBe(900);
  });
});

describe('whosings settings', () => {
  beforeEach(installLocalStorage);

  it('falls back to defaults on missing or junk data', () => {
    expect(parseSettings(null)).toEqual({ speed: 'normal', offsetMs: 0 });
    expect(parseSettings('not json')).toEqual({ speed: 'normal', offsetMs: 0 });
    expect(parseSettings('{"speed":"warp","offsetMs":"x"}')).toEqual({ speed: 'normal', offsetMs: 0 });
  });

  it('clamps and snaps the offset', () => {
    expect(clampOffset(123)).toBe(120);
    expect(clampOffset(-9999)).toBe(-OFFSET_LIMIT);
    expect(clampOffset(NaN)).toBe(0);
    expect(parseSettings('{"speed":"fast","offsetMs":5000}')).toEqual({ speed: 'fast', offsetMs: OFFSET_LIMIT });
  });

  it('round-trips through storage', () => {
    saveSettings({ speed: 'slow', offsetMs: -40 });
    expect(loadSettings()).toEqual({ speed: 'slow', offsetMs: -40 });
  });
});

describe('countdownStep', () => {
  it('counts 3, 2, 1 then stops', () => {
    expect(countdownStep(3000)).toBe(3);
    expect(countdownStep(2001)).toBe(3);
    expect(countdownStep(2000)).toBe(2);
    expect(countdownStep(1)).toBe(1);
    expect(countdownStep(0)).toBeNull();
    expect(countdownStep(-50)).toBeNull();
  });

  it('never shows more than the count-in length', () => {
    expect(countdownStep(5000)).toBe(3);
  });
});

describe('accuracyPct', () => {
  it('rounds and guards against zero', () => {
    expect(accuracyPct(2, 3)).toBe(67);
    expect(accuracyPct(0, 0)).toBe(0);
  });
});

describe('memberStats', () => {
  const lines: WsLine[] = [
    { start: 0, end: 1, ans: [1], lyric: '' },
    { start: 1, end: 2, ans: [1, 2], lyric: '' },
    { start: 2, end: 3, ans: [3], lyric: '' },
    { start: 3, end: 4, ans: [2], lyric: '' },
  ];

  it('counts spotted lines and mix-ups per member, judged lines only', () => {
    const results: (LineResult | null)[] = ['right', 'wrong', 'wrong', null];
    const guesses = [new Set([1]), new Set([1]), new Set([2]), new Set([2])];
    expect(memberStats([1, 2, 3], lines, results, guesses)).toEqual([
      { member: 1, lines: 2, caught: 2, wrongPicks: 0 },
      { member: 2, lines: 1, caught: 0, wrongPicks: 1 },
      { member: 3, lines: 1, caught: 0, wrongPicks: 0 },
    ]);
  });

  it('comes from a session in play', () => {
    const s = new GuessSession(lines);
    s.update(0);
    s.toggle(1, 0.5);
    s.update(1.5);
    s.toggle(1, 1.5);
    s.toggle(2, 1.6);
    s.update(2.5);
    const [m1, m2] = s.memberStats([1, 2]);
    expect(m1).toEqual({ member: 1, lines: 2, caught: 2, wrongPicks: 0 });
    expect(m2).toEqual({ member: 2, lines: 1, caught: 1, wrongPicks: 0 });
  });
});

describe('revealLines', () => {
  it('keeps every timed line, full-cast included, with its lyric', () => {
    const s = song([
      { lyric: 'solo', range: [0, 1], ans: [1] },
      { lyric: 'everyone', range: [1, 2], ans: [1, 2, 3] },
    ]);
    const lines = revealLines(s);
    expect(lines.map((l) => l.lyric)).toEqual(['solo', 'everyone']);
    expect(activeLineAt(lines, 1.5)).toBe(1);
    expect(activeLineAt(lines, 5)).toBe(-1);
  });
});

describe('laneForKey', () => {
  const lanes = (n: number) => ['a', 's', 'd', 'f', 'g', 'j', 'k', 'l', ';'].map((k) => laneForKey(k, n));

  it('centres an odd cast on the middle key', () => {
    expect(lanes(1)).toEqual([null, null, null, null, 0, null, null, null, null]);
    expect(lanes(3)).toEqual([null, null, null, 0, 1, 2, null, null, null]);
    expect(lanes(9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('splits an even cast across the hands, skipping the middle', () => {
    expect(lanes(2)).toEqual([null, null, null, 0, null, 1, null, null, null]);
    expect(lanes(4)).toEqual([null, null, 0, 1, null, 2, 3, null, null]);
    expect(lanes(8)).toEqual([0, 1, 2, 3, null, 4, 5, 6, 7]);
  });

  it('treats g, h and space as the middle key, case-insensitively', () => {
    expect(laneForKey('h', 5)).toBe(2);
    expect(laneForKey(' ', 5)).toBe(2);
    expect(laneForKey('F', 5)).toBe(1);
  });

  it('ignores other keys and casts too big for the keyboard', () => {
    expect(laneForKey('q', 9)).toBeNull();
    expect(laneForKey('a', 12)).toBeNull();
    expect(laneForKey('a', 0)).toBeNull();
  });
});
