// Which lines of one song Bubudle can quiz, in the order the daily pick and
// rotation index them. Plain JS (typed by bubudle-lines.d.ts) so the page and
// scripts/ship-songs.js, which writes the per-mode pool file at deploy, share
// one implementation: the pool's order and line identities have to match what
// the page derives from the full song after it loads it.

function sortedSingers(ans) {
  return [...ans].filter((a) => a > 0).sort((a, b) => a - b);
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The song's roster (every member id with a line) and its quizzable lines:
 * a non-empty lyric with an answer that isn't the whole roster. Null for
 * hidden songs and songs without `lines` (legacy mapping-only configs).
 */
export function songLines(song) {
  if (!song.lines || song.hidden) return null;

  const all = new Set();
  for (const line of song.lines) {
    if (typeof line === 'string') continue;
    if (line.parts) {
      for (const p of line.parts) if (p.ans) for (const a of p.ans) if (a > 0) all.add(a);
    } else if (line.ans) {
      for (const a of line.ans) if (a > 0) all.add(a);
    }
  }
  const singers = Array.from(all).sort((a, b) => a - b);

  const lines = [];
  for (const line of song.lines) {
    if (typeof line === 'string') continue;
    const diff = line.diff ?? 1;
    if (line.parts) {
      for (const part of line.parts) {
        if (part.ans && part.ans.length > 0 && part.lyric.trim() && part.range) {
          const ans = sortedSingers(part.ans);
          if (ans.length === 0 || sameIds(ans, singers)) continue;
          lines.push({ lyric: part.lyric, lyricJp: line.lyric_jp, ans, range: part.range, diff, sourceLine: line });
        }
      }
    } else if (line.ans && line.ans.length > 0 && line.lyric?.trim() && line.range) {
      const ans = sortedSingers(line.ans);
      if (ans.length === 0 || sameIds(ans, singers)) continue;
      lines.push({ lyric: line.lyric, lyricJp: line.lyric_jp, ans, range: line.range, diff, sourceLine: line });
    }
  }
  return { singers, lines };
}

/**
 * The song as the pool file carries it: just what filtering and the daily pick
 * read. A line is [start, end] or [start, end, diff] when diff isn't 1; its
 * position is its index into songLines(song).lines. Null when nothing is quizzable.
 */
export function poolSong(song) {
  const sl = songLines(song);
  if (!sl || sl.lines.length === 0) return null;
  const out = { id: song.id, group: song.group };
  if (song.menu != null) out.menu = song.menu;
  out.singers = sl.singers;
  out.lines = sl.lines.map((l) => (l.diff === 1 ? [l.range[0], l.range[1]] : [l.range[0], l.range[1], l.diff]));
  return out;
}
