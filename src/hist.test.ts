import { describe, expect, it, beforeEach } from 'vitest';
import { playResolver, isLineRight, gradePlay, histDate, formatHistDate } from './hist';
import {
  loadHistory, saveHistory, loadChoicesForSong, saveChoicesForSong,
  exportProfileDoc, importProfileDoc, setStorage, type HistRecord,
} from './storage';
import { parseStoredDate } from './achievements';

// vitest runs in node with no localStorage: a minimal in-memory stub whose
// writes can be made to fail like a full origin.
let store: Map<string, string>;
let quotaLeft = Infinity;
function installLocalStorage(): void {
  store = new Map();
  quotaLeft = Infinity;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (v.length > quotaLeft) {
        const err = new Error('quota'); err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(k, String(v));
    },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
}

const YOZORA = 'Yozora wa Nandemo Shitteru no?';
const SONGS = [
  { id: 'yozora-test', name: YOZORA, hidden: true },
  { id: 'yozora', name: YOZORA },
  { id: 'aozora', name: 'Aozora Jumping Heart' },
];

describe('playResolver', () => {
  const resolve = playResolver(SONGS);

  it('resolves by id first', () => {
    expect(resolve({ songId: 'yozora-test', songName: YOZORA })?.id).toBe('yozora-test');
    expect(resolve({ songId: 'aozora', songName: 'Old Title' })?.id).toBe('aozora');
  });

  it('falls back to the name, preferring a non-hidden song', () => {
    expect(resolve({ songName: YOZORA })?.id).toBe('yozora');
    expect(playResolver([...SONGS].reverse())({ songName: YOZORA })?.id).toBe('yozora');
  });

  it('uses the first song when every match is hidden', () => {
    const r = playResolver([{ id: 'a', name: 'X', hidden: true }, { id: 'b', name: 'X', hidden: true }]);
    expect(r({ songName: 'X' })?.id).toBe('a');
  });

  it('falls back to the name when the id no longer exists', () => {
    expect(resolve({ songId: 'aozora-old-id', songName: 'Aozora Jumping Heart' })?.id).toBe('aozora');
  });

  it('returns undefined for unknown songs', () => {
    expect(resolve({ songName: 'Nope' })).toBeUndefined();
    expect(resolve({ songId: 'nope', songName: 'Nope' })).toBeUndefined();
  });
});

describe('grading', () => {
  it('matches the play page Check rule', () => {
    expect(isLineRight([1, 2], [1, 2])).toBe(true);
    expect(isLineRight([1], [1, 2])).toBe(false);
    expect(isLineRight([], [])).toBe(false);
    expect(isLineRight([], [1])).toBe(false);
  });

  it('counts total, attempted and correct lines', () => {
    expect(gradePlay([[[1], [1]], [[2], [3]], [[], [4]], [[1, 2], [1, 2]]]))
      .toEqual({ total: 4, attempted: 3, correct: 2 });
    expect(gradePlay([])).toEqual({ total: 0, attempted: 0, correct: 0 });
  });
});

describe('dates', () => {
  it('stamps a local-time ISO day, not UTC', () => {
    // 23:30 local on Oct 4 is Oct 5 in UTC for any zone behind UTC.
    expect(histDate(new Date(2026, 9, 4, 23, 30))).toBe('2026-10-04');
    expect(histDate(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });

  it('streak parsing reads new ISO days and old locale dates alike', () => {
    expect(parseStoredDate('2026-10-04', 'dmy')).toBe('2026-10-04');
    expect(parseStoredDate('10/4/2026', 'mdy')).toBe('2026-10-04');
    expect(parseStoredDate('4.10.2026', 'dmy')).toBe('2026-10-04');
    expect(parseStoredDate('2026-13-04', 'mdy')).toBeNull();
  });

  it('shows ISO days in the locale and leaves older strings as saved', () => {
    expect(formatHistDate('2026-10-04')).toBe(new Date(2026, 9, 4).toLocaleDateString());
    expect(formatHistDate('10/4/2026')).toBe('10/4/2026');
  });
});

describe('history storage', () => {
  beforeEach(installLocalStorage);

  const play = (over: Partial<HistRecord> = {}): HistRecord =>
    ({ date: '2026-10-04', songName: YOZORA, songId: 'yozora', slots: [[[1], [1]]], ...over });

  it('round-trips records with a song id', () => {
    expect(saveHistory(play())).toBe(true);
    expect(loadHistory()).toEqual([play()]);
    expect(JSON.parse(store.get('hist')!)).toEqual([['2026-10-04', YOZORA, [[[1], [1]]], 'yozora']]);
  });

  it('loads legacy three-field records without a song id', () => {
    store.set('hist', JSON.stringify([['9/27/2026', YOZORA, [[[1], [1]]]]]));
    saveHistory(play());
    const hist = loadHistory();
    expect(hist[0]).toEqual({ date: '9/27/2026', songName: YOZORA, slots: [[[1], [1]]] });
    expect('songId' in hist[0]).toBe(false);
    expect(hist[1].songId).toBe('yozora');
  });

  it('reads corrupt storage as empty instead of throwing', () => {
    store.set('hist', '{not json');
    expect(loadHistory()).toEqual([]);
    store.set('hist', '{"a":1}');
    expect(loadHistory()).toEqual([]);
    store.set('x-selections', 'nope');
    expect(loadChoicesForSong('x')).toEqual({});
    store.set('x-selections', '[1,2]');
    expect(loadChoicesForSong('x')).toEqual({});
  });

  it('drops malformed records and selection entries, keeping the rest', () => {
    store.set('hist', JSON.stringify([
      ['d', 'A', [[[1], [1]]]],
      ['d', 'B', [[['1'], [1]]]],
      ['d', 'C'],
      ['d', 'D', [], 42],
      null,
    ]));
    expect(loadHistory().map(r => r.songName)).toEqual(['A']);
    store.set('x-selections', JSON.stringify({ '1/2': [1], '3/4': 'junk', '5/6': [] }));
    expect(loadChoicesForSong('x')).toEqual({ '1/2': [1], '5/6': [] });
  });

  it('saving after corrupt storage starts a fresh log', () => {
    store.set('hist', '{not json');
    expect(saveHistory(play())).toBe(true);
    expect(loadHistory()).toEqual([play()]);
  });

  it('reports a failed write instead of throwing', () => {
    quotaLeft = 0;
    expect(setStorage('k', 'v')).toBe(false);
    expect(saveChoicesForSong('x', { '1/2': [1] })).toBe(false);
  });

  it('trims the oldest plays and retries once when over quota', () => {
    const old = Array.from({ length: 20 }, (_, i) => play({ songName: `old-${i}`, songId: undefined }));
    for (const r of old) saveHistory(r);
    // One record short of room for all 21; the retry sheds the oldest tenth (3).
    const all = JSON.parse(store.get('hist')!).concat([['2026-10-04', YOZORA, [[[1], [1]]], 'yozora']]);
    quotaLeft = JSON.stringify(all.slice(1)).length;
    expect(saveHistory(play())).toBe(true);
    const hist = loadHistory();
    expect(hist).toHaveLength(18);
    expect(hist[0].songName).toBe('old-3');
    expect(hist[hist.length - 1]).toEqual(play());
  });

  it('gives up after one retry, leaving the stored log as it was', () => {
    saveHistory(play({ songName: 'kept' }));
    const before = store.get('hist');
    quotaLeft = 10;
    expect(saveHistory(play())).toBe(false);
    expect(store.get('hist')).toBe(before);
  });

  it('round-trips both record shapes through profile export/import', () => {
    store.set('hist', JSON.stringify([['9/27/2026', 'Legacy', [[[1], [1]]]]]));
    saveHistory(play());
    const doc = exportProfileDoc('anime');
    installLocalStorage();
    expect(importProfileDoc(doc)).toMatchObject({ histAdded: 2, histSkipped: 0 });
    expect(loadHistory()).toEqual([
      { date: '9/27/2026', songName: 'Legacy', slots: [[[1], [1]]] },
      play(),
    ]);
    expect(importProfileDoc(doc)).toMatchObject({ histAdded: 0, histSkipped: 2 });
  });

  it('import replaces a corrupt local log rather than failing', () => {
    store.set('hist', '{not json');
    const doc = { kind: 'bubudesuwho-profile', data: { hist: JSON.stringify([['d', 'A', [], 'a']]) } };
    expect(importProfileDoc(doc)).toMatchObject({ histAdded: 1 });
    expect(loadHistory()).toEqual([{ date: 'd', songName: 'A', songId: 'a', slots: [] }]);
  });

  it('import still rejects a malformed incoming record', () => {
    const doc = { kind: 'bubudesuwho-profile', data: { hist: JSON.stringify([['d', 'A', [], 7]]) } };
    expect(() => importProfileDoc(doc)).toThrow('Bad hist entry shape.');
  });
});
