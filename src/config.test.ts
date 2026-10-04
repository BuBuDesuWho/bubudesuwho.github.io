import { describe, expect, it } from 'vitest';
import { preprocessSong, songUrl, contentUrl } from './config';
import type { SongConfig } from './types';

function baseCfg(overrides: Partial<SongConfig> = {}): SongConfig {
  return {
    name: 'Test Song',
    id: 'test',
    group: 'aqours',
    ogg: 'sound/test.ogg',
    ...overrides,
  };
}

describe('preprocessSong', () => {
  it('produces slots, lyrics, and hasLyrics for a basic two-line config', () => {
    const cfg = baseCfg({
      lines: [
        { lyric: 'first', range: [0, 1], ans: [1] },
        { lyric: 'second', range: [1, 2], ans: [2] },
      ],
    });
    const song = preprocessSong(cfg);
    expect(song.hasLyrics).toBe(true);
    expect(song.slotsBase).toHaveLength(2);
    expect(song.slotsBase[0].mapping.ans).toEqual([1]);
    expect(song.slotsBase[1].mapping.ans).toEqual([2]);
    expect(song.singers).toEqual([1, 2]);
  });

  it('auto-groups consecutive entries with identical ans into one slot', () => {
    const cfg = baseCfg({
      lines: [
        { lyric: 'a', range: [0, 1], ans: [1, 2] },
        { lyric: 'b', range: [1, 2], ans: [1, 2] },
        { lyric: 'c', range: [2, 3], ans: [1, 2] },
        { lyric: 'd', range: [3, 4], ans: [3] },
      ],
    });
    const song = preprocessSong(cfg);
    // First three get grouped (same ans, consecutive) → one slot spanning 0..3.
    // Fourth stands alone.
    expect(song.slotsBase).toHaveLength(2);
    expect(song.slotsBase[0].mapping.range).toEqual([0, 3]);
    expect(song.slotsBase[0].mapping.ans).toEqual([1, 2]);
    expect(song.slotsBase[1].mapping.range).toEqual([3, 4]);
    expect(song.slotsBase[1].mapping.ans).toEqual([3]);
  });

  it('reports hasLyrics=false when no mapped lines exist', () => {
    // String-only `lines` are display-only (chorus separators, etc.) and
    // produce no mappings — hasLyrics should be false.
    const cfg = baseCfg({ lines: ['(intro)', '(outro)'] });
    const song = preprocessSong(cfg);
    expect(song.hasLyrics).toBe(false);
    expect(song.slotsBase).toHaveLength(0);
  });

  it('flattens a `parts` line into multiple mappings on a single display row', () => {
    const cfg = baseCfg({
      lines: [
        {
          lyric_hangul: '안녕 친구',
          parts: [
            { lyric: 'hello', range: [0, 1], ans: [1] },
            { lyric: 'friend', range: [1, 2], ans: [2] },
          ],
        },
      ],
    });
    const song = preprocessSong(cfg);
    // Two distinct mappings (one per part), each with its own ans.
    expect(song.slotsBase).toHaveLength(2);
    expect(song.slotsBase.map((s) => s.mapping.ans)).toEqual([[1], [2]]);
    // Both parts render on a single newline-free lyrics row.
    expect(song.lyricsBase.filter((t) => t.type === 'newline')).toHaveLength(0);
  });

  it('reports hasLyrics=false for legacy songs with mapping but no lyrics field', () => {
    // Some legacy songs ship `mapping` (timing + answers) without a `lyrics`
    // string — they drive the quiz but have no displayable lyric text.
    const cfg = baseCfg({
      mapping: [
        { id: 0, range: [0, 1], ans: [1] },
        { id: 0, range: [1, 2], ans: [2] },
      ],
    });
    const song = preprocessSong(cfg);
    expect(song.hasLyrics).toBe(false);
    expect(song.slotsBase).toHaveLength(2);
  });

  it('reports hasLyrics=true for legacy songs with both lyrics and mapping', () => {
    const cfg = baseCfg({
      lyrics: '{a} {b}',
      mapping: [
        { id: 0, range: [0, 1], ans: [1] },
        { id: 0, range: [1, 2], ans: [2] },
      ],
    });
    const song = preprocessSong(cfg);
    expect(song.hasLyrics).toBe(true);
  });

  it('drops slots flagged via slots: [{ command: "ignore", slots: [...] }]', () => {
    const cfg = baseCfg({
      lines: [
        { lyric: 'a', range: [0, 1], ans: [1] },
        { lyric: 'b', range: [1, 2], ans: [2] },
        { lyric: 'c', range: [2, 3], ans: [3] },
      ],
      slots: [{ command: 'ignore', slots: [1] }],
    });
    const song = preprocessSong(cfg);
    expect(song.slotsBase).toHaveLength(2);
    expect(song.slotsBase.map((s) => s.mapping.ans)).toEqual([[1], [3]]);
  });
});

describe('songUrl', () => {
  it('versions a song by its content hash when the index has one', () => {
    expect(songUrl('aqours/aozora.json', 'abc123def0')).toBe('/songs/aqours/aozora.json?v=abc123def0');
  });

  it('falls back to the build version without a hash (dev index)', () => {
    expect(songUrl('aqours/aozora.json', undefined)).toBe(contentUrl('songs/aqours/aozora.json'));
  });
});
