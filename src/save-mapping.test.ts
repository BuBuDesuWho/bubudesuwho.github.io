import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import {
  applyEditedConfig, countEntries, isSafeSongFile, resolveSongFile, SaveMappingRequest, SongIndexEntry,
} from './save-mapping';

const INDEX: SongIndexEntry[] = [
  { id: 'aozora', group: 'aqours', file: 'aqours/aozora.json' },
  { id: 'koitan', group: 'muse', file: 'legacy/koitan.json' },
  { id: 'run', group: 'stray-kids', file: 'stray-kids/run.json' },
  { id: 'run', group: 'bts', file: 'bts/run.json' },
  { id: 'liella-song', group: 'liella', file: 'liella/liella-song.json' },
];

describe('resolveSongFile', () => {
  it('finds groups outside the old hardcoded list', () => {
    expect(resolveSongFile(INDEX, 'liella-song', 'liella')).toEqual({ ok: true, value: 'liella/liella-song.json' });
  });

  it('tells apart songs that share an id by group', () => {
    expect(resolveSongFile(INDEX, 'run', 'bts')).toEqual({ ok: true, value: 'bts/run.json' });
    expect(resolveSongFile(INDEX, 'run', 'stray-kids')).toEqual({ ok: true, value: 'stray-kids/run.json' });
  });

  it('404s an unknown song with a message naming the index', () => {
    const r = resolveSongFile(INDEX, 'nope', 'aqours');
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(!r.ok && r.error).toContain('songs/index.*.json');
  });

  it('refuses an id + group listed twice', () => {
    const dup = [...INDEX, { id: 'aozora', group: 'aqours', file: 'aqours/aozora-2.json' }];
    expect(resolveSongFile(dup, 'aozora', 'aqours')).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses an index path that escapes songs/', () => {
    const evil = [{ id: 'x', group: 'aqours', file: '../vite.config.json' }];
    expect(resolveSongFile(evil, 'x', 'aqours')).toMatchObject({ ok: false, status: 400 });
  });
});

describe('isSafeSongFile', () => {
  it.each(['aqours/aozora.json', 'aqours/legacy/shadow.json', 'top-level.json'])('accepts %s', (f) => {
    expect(isSafeSongFile(f)).toBe(true);
  });
  it.each([
    '../x.json', 'aqours/../../x.json', '/etc/x.json', 'aqours//x.json', 'aqours/.hidden.json',
    'aqours\\x.json', 'aqours/x.js', '',
  ])('rejects %s', (f) => {
    expect(isSafeSongFile(f)).toBe(false);
  });

  it('accepts every file in the real song indexes', () => {
    for (const idx of ['index.anime.json', 'index.kpop.json']) {
      const entries = JSON.parse(readFileSync(new URL(`../songs/${idx}`, import.meta.url), 'utf-8')) as SongIndexEntry[];
      const rejected = entries.filter((e) => !isSafeSongFile(e.file)).map((e) => e.file);
      expect(rejected, idx).toEqual([]);
    }
  });
});

describe('applyEditedConfig', () => {
  const linesCfg = { name: 'A', id: 'aozora', group: 'aqours', lines: [{ lyric: 'a', range: [0, 1], ans: [1] }], slots: [] };
  const mappingCfg = { name: 'K', id: 'koitan', group: 'muse', legacy: true, mapping: [{ ans: [1], range: [0, 1] }] };

  it('replaces lines and keeps every other field in place', () => {
    const req: SaveMappingRequest = { songId: 'aozora', group: 'aqours', format: 'lines', lines: ['', { lyric: 'b', range: [0, 2], ans: [2] }] };
    const r = applyEditedConfig(linesCfg, req);
    expect(r.ok && r.value).toEqual({ ...linesCfg, lines: req.lines });
    expect(r.ok && Object.keys(r.value)).toEqual(Object.keys(linesCfg));
  });

  it('replaces mapping sorted by start time and never adds lines', () => {
    const req: SaveMappingRequest = {
      songId: 'koitan', group: 'muse', format: 'mapping',
      mapping: [{ ans: [2], range: [5, 6] }, { ans: [1], range: [0, 1] }],
    };
    const r = applyEditedConfig(mappingCfg, req);
    expect(r.ok && r.value).toEqual({ ...mappingCfg, mapping: [{ ans: [1], range: [0, 1] }, { ans: [2], range: [5, 6] }] });
    expect(r.ok && 'lines' in r.value).toBe(false);
  });

  it('refuses a mapping edit for a lines file and vice versa', () => {
    expect(applyEditedConfig(linesCfg, { songId: 'aozora', group: 'aqours', format: 'mapping', mapping: [] }))
      .toMatchObject({ ok: false, status: 409 });
    expect(applyEditedConfig(mappingCfg, { songId: 'koitan', group: 'muse', format: 'lines', lines: [] }))
      .toMatchObject({ ok: false, status: 409 });
  });

  it('refuses a file that holds a different song', () => {
    expect(applyEditedConfig(linesCfg, { songId: 'aozora', group: 'bts', format: 'lines', lines: [] }))
      .toMatchObject({ ok: false, status: 409 });
  });
});

describe('countEntries', () => {
  it('counts timed entries: one per plain line, one per part, none for separators', () => {
    expect(countEntries({
      format: 'lines',
      lines: ['', { lyric: 'a', range: [0, 1] }, { parts: [{ lyric: 'b', range: [1, 2] }, { lyric: 'c', range: [2, 3] }] }],
    })).toBe(3);
    expect(countEntries({ format: 'mapping', mapping: [{ range: [0, 1] }, { range: [1, 2] }] })).toBe(2);
  });
});
