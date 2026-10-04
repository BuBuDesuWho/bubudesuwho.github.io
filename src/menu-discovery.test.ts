import { describe, expect, it } from 'vitest';
import type { MenuSong } from './types';
import type { HistRecord } from './storage';
import {
  normalize, rankSongs, scoreSong, searchFields, buildProgress, songStatus,
  matchesFilter, recentSongIds, pickRandom, hasAnyPick,
} from './menu-discovery';

const song = (id: string, name: string, extra: Partial<MenuSong> = {}): MenuSong =>
  ({ id, name, group: 'aqours', ...extra }) as MenuSong;

const SONGS: MenuSong[] = [
  song('aozora-jumping-heart', 'Aozora Jumping Heart', { name_jp: '青空Jumping Heart', album: 'Aozora Jumping Heart' }),
  song('koi-ni-naritai-aquarium', 'Koi ni Naritai AQUARIUM', { name_jp: '恋になりたいAQUARIUM' }),
  song('mijuku-dreamer', 'Mijuku DREAMER', { name_jp: 'ミジュクドリーマー' }),
  song('snow-halation', 'Snow halation', { group: 'muse' }),
  song('cafe-song', 'Café Mélodie'),
  song('aqours-heroes', 'Aqours☆HEROES', { album: 'Aozora Jumping Heart' }),
];

const names = (q: string) => rankSongs(SONGS, q).map((r) => r.song.id);

describe('normalize', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalize('Café  Mélodie!')).toBe('cafe melodie');
    expect(normalize('koi-ni-naritai')).toBe('koi ni naritai');
    expect(normalize("μ's")).toBe('mus');
  });
  it('folds katakana to hiragana and full-width to ASCII', () => {
    expect(normalize('ミジュク')).toBe(normalize('みじゅく'));
    expect(normalize('ＡＱＵＡ')).toBe('aqua');
  });
});

describe('search ranking', () => {
  it('matches without accents or case', () => {
    expect(names('cafe melodie')).toEqual(['cafe-song']);
  });
  it('puts title-prefix matches ahead of album matches', () => {
    const ids = names('aozora');
    expect(ids[0]).toBe('aozora-jumping-heart');
    expect(ids).toContain('aqours-heroes');
  });
  it('matches Japanese titles in either kana script', () => {
    expect(names('みじゅく')).toEqual(['mijuku-dreamer']);
    expect(names('恋に')).toEqual(['koi-ni-naritai-aquarium']);
  });
  it('matches song ids', () => {
    expect(names('snow-halation')).toEqual(['snow-halation']);
  });
  it('tolerates skipped letters with fuzzy matching', () => {
    expect(names('aquarm')[0]).toBe('koi-ni-naritai-aquarium');
  });
  it('requires every token to match something', () => {
    expect(names('snow aquarium')).toEqual([]);
  });
  it('does not fuzzy-match very short tokens', () => {
    expect(scoreSong(searchFields(SONGS[3]), 'sx')).toBe(0);
  });
  it('applies the caller boost', () => {
    const ranked = rankSongs(SONGS, 'heart', (s) => (s.id === 'aqours-heroes' ? 1000 : 0));
    expect(ranked[0].song.id).toBe('aqours-heroes');
  });
});

const rec = (songName: string, slots: [number[], number[]][]): HistRecord => ({ date: '1/1/2026', songName, slots });

describe('progress', () => {
  const hist = [
    rec('Mijuku DREAMER', [[[1], [1]], [[2], [3]]]),
    rec('Mijuku DREAMER', [[[1], [1]], [[3], [3]]]),
    rec('Snow halation', [[[1], [1]], [[], [2]]]),
    rec('Unknown Song', [[[1], [1]]]),
  ];
  const progress = buildProgress(hist, SONGS);

  it('tracks plays, best accuracy and mastery by song id', () => {
    expect(progress.get('mijuku-dreamer')).toEqual({ plays: 2, best: 100, mastered: true });
    expect(progress.get('snow-halation')).toEqual({ plays: 1, best: 50, mastered: false });
    expect(progress.size).toBe(2);
  });

  it('derives status, counting saved picks as started', () => {
    expect(songStatus(progress.get('mijuku-dreamer'), false)).toBe('mastered');
    expect(songStatus(progress.get('snow-halation'), false)).toBe('progress');
    expect(songStatus(undefined, true)).toBe('progress');
    expect(songStatus(undefined, false)).toBe('unplayed');
  });

  it('only counts saved selections that contain a pick', () => {
    expect(hasAnyPick('{"1/2":[],"3/4":[]}')).toBe(false);
    expect(hasAnyPick('{"1/2":[],"3/4":[2]}')).toBe(true);
    expect(hasAnyPick('not json')).toBe(false);
    expect(hasAnyPick(null)).toBe(false);
  });

  it('filters by status and favorites', () => {
    expect(matchesFilter('all', 'unplayed', false)).toBe(true);
    expect(matchesFilter('mastered', 'progress', true)).toBe(false);
    expect(matchesFilter('favorites', 'unplayed', true)).toBe(true);
  });

  it('lists recent distinct songs newest first', () => {
    expect(recentSongIds(hist, SONGS, 5)).toEqual(['snow-halation', 'mijuku-dreamer']);
    expect(recentSongIds(hist, SONGS, 1)).toEqual(['snow-halation']);
  });

  // songs/index.anime.json lists hidden `yozora-test` ahead of `yozora`
  // under the same name; legacy name-only plays belong to the real one.
  it('credits name-only plays to the visible song when a hidden one shares the name', () => {
    const name = 'Yozora wa Nandemo Shitteru no?';
    const songs = [song('yozora-test', name, { hidden: true }), song('yozora', name)];
    const plays = [rec(name, [[[1], [1]]]), { ...rec(name, [[[2], [1]]]), songId: 'yozora-test' }];
    const p = buildProgress(plays, songs);
    expect(p.get('yozora')).toEqual({ plays: 1, best: 100, mastered: true });
    expect(p.get('yozora-test')).toEqual({ plays: 1, best: 0, mastered: false });
    expect(recentSongIds(plays, songs, 5)).toEqual(['yozora-test', 'yozora']);
  });
});

describe('pickRandom', () => {
  it('uses the rng and handles empty lists', () => {
    expect(pickRandom([1, 2, 3], () => 0.99)).toBe(3);
    expect(pickRandom([], () => 0)).toBeUndefined();
  });
});
