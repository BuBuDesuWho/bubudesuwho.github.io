// Bubudle used to fetch every song (loadConfig) and build its candidates from
// the full configs; it now picks from the shipped pool file and fetches one
// song. This runs both against the real catalog on disk and checks they agree:
// same lines in the same order for every scope, the same daily for every day
// of the archive (and a month ahead), and the same full line once the picked
// song is loaded. JS rather than TS because it imports scripts/ship-songs.js,
// the code that writes the pool at deploy.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { preprocessSong } from './config';
import { registerGroup, clearGroups, isExcludedFrom } from './groups';
import { eligibleCandidates, poolCandidates, resolvePoolLine } from './candidate-pool';
import { loadDailyManifest, pickDailyLine, manifestLoaded, archiveEntry } from './bubudle-archive';
import { lineKey } from './bubudle-rotation';
import { ARCHIVE_START, currentDateEst, shiftDate } from './bubudle-daily';
import { buildPool, shipSong } from '../scripts/ship-songs.js';

const read = (path) => readFileSync(new URL(`../songs/${path}`, import.meta.url), 'utf8');

// What loadConfig() returned: one song per index id, in first-seen order, read
// from the id's last entry (config.ts keys its index cache by id).
function loadConfigFromDisk(index) {
  const byId = new Map();
  for (const e of index) byId.set(e.id, e);
  return [...byId.values()].map((e) => {
    const cfg = JSON.parse(read(e.file));
    if (e.cover && !cfg.cover) cfg.cover = e.cover;
    return preprocessSong(cfg);
  });
}

// The candidate builder from src/bubudle.ts as it was before the pool,
// verbatim apart from types and returning the list: the reference the pool
// has to reproduce.
function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function collectCandidates(songs, include) {
  const candidates = [];
  for (const song of songs) {
    if (!song.lines || song.hidden) continue;
    if (!include(song)) continue;

    const allSingers = new Set();
    for (const line of song.lines) {
      if (typeof line === 'string') continue;
      const obj = line;
      if (obj.parts) {
        for (const p of obj.parts) {
          if (p.ans) for (const a of p.ans) if (a > 0) allSingers.add(a);
        }
      } else if (obj.ans) {
        for (const a of obj.ans) if (a > 0) allSingers.add(a);
      }
    }
    const singerArr = Array.from(allSingers).sort((a, b) => a - b);

    for (const line of song.lines) {
      if (typeof line === 'string') continue;
      const obj = line;
      const lineDiff = obj.diff ?? 1;

      if (obj.parts) {
        for (const part of obj.parts) {
          if (part.ans && part.ans.length > 0 && part.lyric.trim() && part.range) {
            const sorted = [...part.ans].filter(a => a > 0).sort((a, b) => a - b);
            if (sorted.length === 0) continue;
            if (arrEq(sorted, singerArr)) continue;
            candidates.push({ lyric: part.lyric, lyricJp: obj.lyric_jp, ans: sorted, range: part.range, song, diff: lineDiff, sourceLine: obj, allSingers: singerArr });
          }
        }
      } else if (obj.ans && obj.ans.length > 0 && obj.lyric?.trim() && obj.range) {
        const sorted = [...obj.ans].filter(a => a > 0).sort((a, b) => a - b);
        if (sorted.length === 0) continue;
        if (arrEq(sorted, singerArr)) continue;
        candidates.push({ lyric: obj.lyric, lyricJp: obj.lyric_jp, ans: sorted, range: obj.range, song, diff: lineDiff, sourceLine: obj, allSingers: singerArr });
      }
    }
  }
  return candidates;
}

// Scope filters as bubudle.ts applies them (buildCandidatePool / ...All).
const excluded = (g) => isExcludedFrom(g, 'bubudle');
function includeFor(scope) {
  return (s) => {
    const menu = s.menu ?? s.group;
    return scope.kind === 'mode' ? !excluded(menu) : menu === scope.group && !excluded(menu);
  };
}

// Cached: the rotation walk keys the whole pool once per simulated day.
const keys = new WeakMap();
const keyOf = (c) => {
  let k = keys.get(c);
  if (k === undefined) keys.set(c, k = lineKey(c.song.id, c.range));
  return k;
};
const full = (c, songId) =>
  ({ songId, lyric: c.lyric, lyricJp: c.lyricJp, ans: c.ans, range: c.range, diff: c.diff, allSingers: c.allSingers });

const ALL_FILTERS_OFF = { clipDiff: 'all', songDiff: 'all', subunitInclude: [], subunitExclude: [] };
const LAST = shiftDate(currentDateEst(), 30);

beforeAll(async () => {
  const manifest = read('daily-manifest.json');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(manifest, { status: 200 })));
  await loadDailyManifest();
});
afterAll(() => {
  vi.unstubAllGlobals();
  clearGroups();
});

for (const mode of ['anime', 'kpop']) {
  describe(`bubudle pool matches the full-catalog build (${mode})`, () => {
    const index = JSON.parse(read(`index.${mode}.json`));
    const groups = JSON.parse(read(`groups.${mode}.json`)).groups.map((slug) => JSON.parse(read(`${slug}/group.json`)));
    const oldSongs = loadConfigFromDisk(index);
    // Exactly the bytes a deploy ships, through a JSON round trip.
    const shipped = new Map(index.map((e) => [e.file, JSON.parse(shipSong(read(e.file)).body)]));
    const pool = JSON.parse(JSON.stringify(buildPool(index, (e) => shipped.get(e.file))));
    // What loadSongById hands the page for a picked id (last entry wins, as in config.ts).
    const fileOf = new Map(index.map((e) => [e.id, e.file]));
    const loaded = new Map();
    const loadById = (id) => {
      if (!loaded.has(id)) loaded.set(id, preprocessSong(structuredClone(shipped.get(fileOf.get(id)))));
      return loaded.get(id);
    };
    const resolve = (pc) => {
      const line = resolvePoolLine(loadById(pc.song.id), pc);
      return line && full(line, pc.song.id);
    };

    beforeAll(() => {
      clearGroups();
      for (const g of groups) registerGroup(g);
    });

    const scopes = [
      { kind: 'mode', mode },
      ...groups.filter((g) => !g.excludeFrom?.includes('bubudle')).map((g) => ({ kind: 'group', group: g.slug })),
    ];

    it('loads each pool song by the id its own file carries', () => {
      // The old pool keyed lines by the loaded config's id; the page now loads by index id.
      for (const [id, file] of fileOf) expect(shipped.get(file).id, file).toBe(id);
    });

    for (const scope of scopes) {
      const label = scope.kind === 'mode' ? `mode:${scope.mode}` : `group:${scope.group}`;

      it(`${label}: same lines, same order, and each resolves to the same full line`, () => {
        const before = collectCandidates(oldSongs, includeFor(scope));
        const after = poolCandidates(pool, includeFor(scope));
        expect(after.length).toBe(before.length);
        if (scope.kind === 'mode') expect(after.length).toBeGreaterThan(1000);
        for (let i = 0; i < before.length; i++) {
          const b = before[i];
          const a = after[i];
          expect(keyOf(a)).toBe(keyOf(b));
          expect([a.diff, a.allSingers, a.song.group, a.song.menu]).toEqual([b.diff, b.allSingers, b.song.group, b.song.menu]);
          expect(resolve(a)).toEqual(full(b, b.song.id));
        }
      });

      it(`${label}: infinite filters keep the same lines`, () => {
        const before = collectCandidates(oldSongs, includeFor(scope));
        const after = poolCandidates(pool, includeFor(scope));
        const combos = [];
        for (const clipDiff of ['all', 'normal', 'hard', 'insane']) {
          for (const songDiff of ['all', '1', '2', '3']) combos.push({ ...ALL_FILTERS_OFF, clipDiff, songDiff });
        }
        // Subunit filters on a few of the singer sets the scope has.
        for (const k of [...new Set(before.map((c) => c.allSingers.join(',')))].slice(0, 3)) {
          combos.push({ ...ALL_FILTERS_OFF, subunitInclude: [k] }, { ...ALL_FILTERS_OFF, subunitExclude: [k] });
        }
        for (const f of combos) {
          expect(eligibleCandidates(after, f).map(keyOf), JSON.stringify(f)).toEqual(eligibleCandidates(before, f).map(keyOf));
        }
      });

      it(`${label}: same daily for every day from ${ARCHIVE_START} to ${LAST}`, () => {
        expect(manifestLoaded()).toBe(true);
        const before = eligibleCandidates(collectCandidates(oldSongs, includeFor(scope)), ALL_FILTERS_OFF);
        const after = eligibleCandidates(poolCandidates(pool, includeFor(scope)), ALL_FILTERS_OFF);
        let days = 0;
        for (let date = ARCHIVE_START; date <= LAST; date = shiftDate(date, 1)) {
          // Browsing the archive only changes the outcome of a pinned day.
          const pinned = archiveEntry(label, date) !== null;
          for (const archive of pinned ? [false, true] : [false]) {
            const b = pickDailyLine(before, keyOf, scope, date, archive);
            const a = pickDailyLine(after, keyOf, scope, date, archive);
            expect(a && resolve(a), `${label} ${date}`).toEqual(b && full(b, b.song.id));
          }
          days++;
        }
        expect(days).toBeGreaterThan(150);
      }, 120_000);
    }
  });
}
