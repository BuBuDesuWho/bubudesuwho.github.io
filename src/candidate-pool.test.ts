import { describe, expect, it, beforeEach } from 'vitest';
import { registerGroup, clearGroups } from './groups';
import { eligibleCandidates, FilterableCandidate, CandidateFilters, poolCandidates, resolvePoolLine } from './candidate-pool';
import type { PoolSong } from './bubudle-lines';

type C = FilterableCandidate & { label: string };

function cand(label: string, dur: number, diff: number, allSingers: number[], group = 'aqours'): C {
  return { label, range: [0, dur], diff, allSingers, song: { group } };
}

const NO_FILTER: CandidateFilters = { clipDiff: 'all', songDiff: 'all', subunitInclude: [], subunitExclude: [] };

function labels(pool: C[], f: Partial<CandidateFilters>): string[] {
  return eligibleCandidates(pool, { ...NO_FILTER, ...f }).map((c) => c.label);
}

describe('eligibleCandidates — clip difficulty', () => {
  const pool = [cand('short', 0.8, 1, [1]), cand('mid', 1.5, 1, [1]), cand('long', 3, 1, [1])];

  it('all keeps every clip length', () => {
    expect(labels(pool, { clipDiff: 'all' })).toEqual(['short', 'mid', 'long']);
  });
  it('normal keeps only clips longer than 2s', () => {
    expect(labels(pool, { clipDiff: 'normal' })).toEqual(['long']);
  });
  it('hard keeps clips at or under 2s', () => {
    expect(labels(pool, { clipDiff: 'hard' })).toEqual(['short', 'mid']);
  });
  it('insane keeps clips at or under 1s', () => {
    expect(labels(pool, { clipDiff: 'insane' })).toEqual(['short']);
  });
});

describe('eligibleCandidates — song difficulty', () => {
  const pool = [cand('d1', 3, 1, [1]), cand('d2', 3, 2, [1]), cand('d3', 3, 3, [1])];

  it('all keeps every tier', () => {
    expect(labels(pool, { songDiff: 'all' })).toEqual(['d1', 'd2', 'd3']);
  });
  it('a numeric tier keeps only that tier', () => {
    expect(labels(pool, { songDiff: '2' })).toEqual(['d2']);
  });
});

describe('eligibleCandidates — subunit include/exclude', () => {
  const pool = [cand('duo', 3, 1, [1, 2]), cand('trio', 3, 1, [3, 4, 5])];

  it('include keeps only matching singer-key', () => {
    expect(labels(pool, { subunitInclude: ['1,2'] })).toEqual(['duo']);
  });
  it('exclude drops the matching singer-key', () => {
    expect(labels(pool, { subunitExclude: ['1,2'] })).toEqual(['trio']);
  });
  beforeEach(() => {
    clearGroups();
    registerGroup({ slug: 'saint-aqours-snow', name: 'Saint Aqours Snow', members: [], subunitFilterAliases: ['10,11'] });
  });
  it('saint-aqours-snow matches the "10,11" Saint Snow key by group', () => {
    const ss = [cand('ss', 3, 1, [1, 2, 3, 10, 11], 'saint-aqours-snow')];
    expect(labels(ss, { subunitInclude: ['10,11'] })).toEqual(['ss']);
    expect(labels(ss, { subunitExclude: ['10,11'] })).toEqual([]);
  });
});

describe('eligibleCandidates — combined filters', () => {
  it('applies clip, song-diff, and subunit together', () => {
    const pool = [
      cand('keep', 3, 2, [1, 2]),
      cand('wrongClip', 1, 2, [1, 2]),
      cand('wrongDiff', 3, 1, [1, 2]),
      cand('wrongUnit', 3, 2, [7, 8]),
    ];
    expect(labels(pool, { clipDiff: 'normal', songDiff: '2', subunitInclude: ['1,2'] })).toEqual(['keep']);
  });
});

describe('poolCandidates', () => {
  const songs: PoolSong[] = [
    { id: 'a', group: 'aqours', singers: [1, 2], lines: [[0, 1], [1, 2, 3]] },
    { id: 'b', group: 'saint-aqours-snow', menu: 'aqours', singers: [10, 11], lines: [[5, 6]] },
    { id: 'c', group: 'muse', singers: [1, 2], lines: [[2, 3]] },
  ];

  it('flattens included songs in order, with position, range, diff and roster', () => {
    const out = poolCandidates(songs, (s) => (s.menu ?? s.group) === 'aqours');
    expect(out.map((c) => [c.song.id, c.ordinal, c.range, c.diff, c.allSingers])).toEqual([
      ['a', 0, [0, 1], 1, [1, 2]],
      ['a', 1, [1, 2], 3, [1, 2]],
      ['b', 0, [5, 6], 1, [10, 11]],
    ]);
  });
});

describe('resolvePoolLine', () => {
  const song = {
    id: 'a', group: 'aqours' as const,
    lines: [
      { lyric: 'one', range: [0, 1] as [number, number], ans: [1] },
      { lyric: 'echo', range: [0, 1] as [number, number], ans: [2] },
      { lyric: 'three', lyric_jp: 'さん', range: [2, 3] as [number, number], ans: [2, 1], diff: 2 },
      { lyric: 'four', range: [3, 4] as [number, number], ans: [3] },
    ],
  };
  const pc = (ordinal: number, range: [number, number]) =>
    ({ song: { id: 'a', group: 'aqours' as const, singers: [1, 2], lines: [] }, ordinal, range, diff: 1, allSingers: [1, 2] });

  it('takes the line at its position, even when another line shares the range', () => {
    expect(resolvePoolLine(song, pc(1, [0, 1]))).toMatchObject({ lyric: 'echo', ans: [2], allSingers: [1, 2, 3] });
  });

  it('carries everything the puzzle renders', () => {
    expect(resolvePoolLine(song, pc(2, [2, 3]))).toMatchObject({ lyric: 'three', lyricJp: 'さん', ans: [1, 2], diff: 2, range: [2, 3] });
  });

  it('falls back to the range when the position moved, and null when the line is gone', () => {
    expect(resolvePoolLine(song, pc(0, [2, 3]))?.lyric).toBe('three');
    expect(resolvePoolLine(song, pc(0, [7, 8]))).toBeNull();
    expect(resolvePoolLine({ ...song, hidden: true }, pc(0, [0, 1]))).toBeNull();
  });
});
