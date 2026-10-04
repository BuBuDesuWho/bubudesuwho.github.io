import { BubudleDifficulty, SongDifficulty } from './bubudle-config';
import { subunitFilterAliases } from './groups';
import { songLines, PoolSong, SongLine } from './bubudle-lines';

// The eligibility filter for the Bubudle candidate pool, lifted out of the page
// module as a pure function: given the full pool and the four active filter
// values, which clips are playable right now? Keeping it parameterised (no
// module-level reads) makes the difficulty × song-difficulty × subunit
// interactions a unit-test surface.

/** Lyric range duration thresholds per clip difficulty (seconds).
 *  All: any length · Normal: clips > 2s · Hard: clips ≤ 2s · Insane: clips ≤ 1s. */
const RANGE_CAPS: Record<BubudleDifficulty, number> = {
  all: Infinity,
  normal: 2,
  hard: 2,
  insane: 1,
};

export interface CandidateFilters {
  clipDiff: BubudleDifficulty;
  songDiff: SongDifficulty;
  subunitInclude: string[];
  subunitExclude: string[];
}

/** The minimal shape the filter reads. A full LyricCandidate satisfies it. */
export interface FilterableCandidate {
  range: [number, number];
  diff: number;
  allSingers: number[];
  song: { group: string };
}

export function eligibleCandidates<T extends FilterableCandidate>(
  candidates: T[],
  f: CandidateFilters,
): T[] {
  const cap = RANGE_CAPS[f.clipDiff];
  const diffFilter = f.songDiff === 'all' ? 0 : parseInt(f.songDiff, 10);
  const includeSet = f.subunitInclude.length > 0 ? new Set(f.subunitInclude) : null;
  const excludeSet = f.subunitExclude.length > 0 ? new Set(f.subunitExclude) : null;
  return candidates.filter((c) => {
    const dur = c.range[1] - c.range[0];
    const clipOk = f.clipDiff === 'all' ? true : f.clipDiff === 'normal' ? dur > cap : dur <= cap;
    if (!clipOk) return false;
    if (diffFilter !== 0 && c.diff !== diffFilter) return false;
    const key = c.allSingers.join(',');
    // Extension groups (saint-aqours-snow) declare subunit keys they also match,
    // since their allSingers span the whole roster and wouldn't hit e.g. "10,11".
    const aliases = subunitFilterAliases(c.song.group);
    const matchesKey = (set: Set<string>): boolean =>
      set.has(key) || aliases.some(a => set.has(a));
    if (includeSet && !matchesKey(includeSet)) return false;
    if (excludeSet && matchesKey(excludeSet)) return false;
    return true;
  });
}

/** A line in the pool: enough to filter and pick, before its song is fetched. */
export interface PoolCandidate extends FilterableCandidate {
  song: PoolSong;
  /** Position in songLines(fullSong).lines. */
  ordinal: number;
}

/** Flatten the pool file's songs into lines, in pool order. */
export function poolCandidates(songs: PoolSong[], include: (s: PoolSong) => boolean): PoolCandidate[] {
  const out: PoolCandidate[] = [];
  for (const song of songs) {
    if (!include(song)) continue;
    song.lines.forEach((l, ordinal) => {
      out.push({ song, ordinal, range: [l[0], l[1]], diff: l[2] ?? 1, allSingers: song.singers });
    });
  }
  return out;
}

/**
 * The full line a pool entry stands for, once its song has loaded. Matched by
 * position, which is exact even when two lines share a range; the range check
 * (and lookup by range) only matters if the pool and song came from different
 * deploys. Null when the song no longer has that line.
 */
export function resolvePoolLine(
  song: Parameters<typeof songLines>[0],
  c: PoolCandidate,
): (SongLine & { allSingers: number[] }) | null {
  const sl = songLines(song);
  if (!sl) return null;
  const same = (l: SongLine) => l.range[0] === c.range[0] && l.range[1] === c.range[1];
  const at = sl.lines[c.ordinal];
  const line = at && same(at) ? at : sl.lines.find(same);
  return line ? { ...line, allSingers: sl.singers } : null;
}
