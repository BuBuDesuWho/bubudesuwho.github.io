import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { preprocessSong } from './config';
import { state } from './game';
import {
  setEditMode, insertMappingAfter, deleteSlot, setSlotSingers, setSlotDiff, setSlotLyric,
  exportEditedConfig,
} from './game-edit';
import type { LineEntry, LinePart, SongConfig } from './types';

// Load a config the way the play page does (minus audio/DOM) and enter edit mode.
function load(overrides: Partial<SongConfig>): void {
  const cfg: SongConfig = { name: 'Test', id: 'test', group: 'aqours', ogg: 'sound/test.ogg', ...overrides };
  const song = preprocessSong(structuredClone(cfg));
  state.song = song;
  state.mapping = song.mapping ?? [];
  setEditMode(true);
}

function exportedLines(): LineEntry[] {
  const out = exportEditedConfig();
  if (out?.format !== 'lines') throw new Error(`expected lines export, got ${out?.format}`);
  return out.lines;
}

// Slots are one per mapping entry in edit mode, in mapping order.
const slot = (i: number) => state.slots[i];

const LINES: LineEntry[] = [
  '',
  { lyric: 'one', lyric_jp: 'いち', range: [0, 1], ans: [1] },
  { lyric: 'two', range: [1, 2], ans: [2], diff: 2 },
  'chorus',
  {
    lyric_jp: 'さん し',
    parts: [
      { lyric: 'three', range: [2, 3], ans: [3] },
      // kdur isn't in LinePart but real parts carry it; export must keep it.
      { lyric: 'four', range: [3, 4], ans: [1, 2], kdur: 5 } as LinePart,
    ],
  },
  { lyric: 'everyone', range: [4, 5], ans: [] },
  { lyric: 'plain', range: [5, 6] },
  { lyric: 'five', range: [6, 7], ans: [2] },
];

describe('exportEditedConfig, lines format', () => {
  it('round-trips an unedited song unchanged', () => {
    load({ lines: LINES });
    expect(exportedLines()).toEqual(LINES);
  });

  it('writes timing, answer, difficulty and lyric edits to the right line and part', () => {
    load({ lines: LINES });
    slot(0).range[0] = 0.25; // the UI's time inputs write the shared range array
    setSlotSingers(slot(1), [3, 1]);
    setSlotDiff(slot(1), 1);
    setSlotLyric(slot(3), 'FOUR');
    setSlotDiff(slot(3), 3);
    const lines = exportedLines();
    expect(lines[1]).toEqual({ lyric: 'one', lyric_jp: 'いち', range: [0.25, 1], ans: [1] });
    expect(lines[2]).toEqual({ lyric: 'two', range: [1, 2], ans: [1, 3] });
    expect(lines[4]).toEqual({
      lyric_jp: 'さん し',
      parts: [
        { lyric: 'three', range: [2, 3], ans: [3] },
        { lyric: 'FOUR', range: [3, 4], ans: [1, 2], kdur: 5, diff: 3 },
      ],
    });
  });

  it('collapses an answer of the full roster back to []', () => {
    load({ lines: LINES });
    setSlotSingers(slot(0), [1, 2, 3]);
    expect(exportedLines()[1]).toMatchObject({ ans: [] });
  });

  it('inserts a new line below without shifting later lines', () => {
    load({ lines: LINES });
    const entry = insertMappingAfter(slot(0)); // after "one"
    setSlotSingers(slot(1), [2]);
    setSlotLyric(slot(1), 'new');
    const lines = exportedLines();
    expect(lines).toHaveLength(LINES.length + 1);
    expect(lines.slice(0, 2)).toEqual(LINES.slice(0, 2));
    expect(lines[2]).toEqual({ lyric: 'new', range: [entry.range[0], entry.range[1]], ans: [2] });
    expect(lines.slice(3)).toEqual(LINES.slice(2));
  });

  it('leaves ans off an inserted line nobody set singers on', () => {
    load({ lines: LINES });
    insertMappingAfter(slot(6)); // after "five", the last line
    const lines = exportedLines();
    expect(lines.slice(0, -1)).toEqual(LINES);
    expect(lines[lines.length - 1]).toEqual({ lyric: '', range: [7, 9] });
  });

  it('turns an entry inserted between two parts into a part of that line', () => {
    load({ lines: LINES });
    insertMappingAfter(slot(2)); // after part "three"
    const parts = (exportedLines()[4] as { parts: unknown[] }).parts;
    expect(parts).toEqual([
      { lyric: 'three', range: [2, 3], ans: [3] },
      { lyric: '', range: [3, 5] },
      { lyric: 'four', range: [3, 4], ans: [1, 2], kdur: 5 },
    ]);
  });

  it('inserts after the last part as a new line, not a part', () => {
    load({ lines: LINES });
    insertMappingAfter(slot(3)); // after part "four"
    const lines = exportedLines();
    expect(lines[4]).toEqual(LINES[4]);
    expect(lines[5]).toEqual({ lyric: '', range: [4, 6] });
    expect(lines.slice(6)).toEqual(LINES.slice(5));
  });

  it('deletes a line without shifting its neighbours', () => {
    load({ lines: LINES });
    deleteSlot(slot(1)); // "two"
    expect(exportedLines()).toEqual(LINES.filter((_, i) => i !== 2));
  });

  it('deletes one part, and drops a line once all its parts are gone', () => {
    load({ lines: LINES });
    deleteSlot(slot(2)); // part "three"
    expect((exportedLines()[4] as { parts: unknown[] }).parts).toEqual([
      { lyric: 'four', range: [3, 4], ans: [1, 2], kdur: 5 },
    ]);
    deleteSlot(slot(2)); // part "four" (now at index 2)
    const lines = exportedLines();
    expect(lines).toEqual(LINES.filter((_, i) => i !== 4));
    expect(lines[3]).toBe('chorus'); // separator survives the dropped line
  });

  it('handles an insert and a delete together', () => {
    load({ lines: LINES });
    deleteSlot(slot(0)); // "one"
    insertMappingAfter(slot(3)); // after "everyone" (index 3 once "one" is gone)
    const lines = exportedLines();
    expect(lines).toEqual([
      '',
      LINES[2],
      'chorus',
      LINES[4],
      LINES[5],
      { lyric: '', range: [5, 7] },
      LINES[6],
      LINES[7],
    ]);
  });

  it('round-trips real song files unchanged', () => {
    // Parts + kdur + unquizzed parts; kpop sibling fields; JP lines with separators.
    for (const file of ['aqours/legacy/mirai.json', 'seventeen/24h.json', 'aqours/namida-times.json']) {
      const cfg = JSON.parse(readFileSync(new URL(`../songs/${file}`, import.meta.url), 'utf-8')) as SongConfig;
      load(cfg);
      expect(exportedLines(), file).toEqual(cfg.lines);
    }
  });
});

describe('exportEditedConfig, mapping-only format', () => {
  const MAPPING = [
    { ans: [1], range: [0, 1] },
    { ans: [2, 3], range: [1, 2], diff: 2 },
    { range: [2, 3] },
    { ans: [3], range: [3, 4] },
  ] as SongConfig['mapping'];

  function exportedMapping() {
    const out = exportEditedConfig();
    if (out?.format !== 'mapping') throw new Error(`expected mapping export, got ${out?.format}`);
    return out.mapping;
  }

  it('reports the mapping format and round-trips unchanged', () => {
    load({ mapping: MAPPING });
    expect(exportedMapping()).toEqual(MAPPING);
  });

  it('keeps edits, inserts and deletes in place', () => {
    load({ mapping: MAPPING });
    setSlotSingers(slot(0), [2]);
    deleteSlot(slot(1));
    insertMappingAfter(slot(1)); // after the unquizzed entry
    setSlotSingers(slot(2), [1, 3]);
    expect(exportedMapping()).toEqual([
      { ans: [2], range: [0, 1] },
      { range: [2, 3] },
      { ans: [1, 3], range: [3, 5] },
      { ans: [3], range: [3, 4] },
    ]);
  });
});
