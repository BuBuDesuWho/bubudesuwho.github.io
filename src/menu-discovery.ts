import type { MenuSong } from './types';
import type { HistRecord } from './storage';
import { playResolver, gradePlay } from './hist';

// Pure logic behind the song menu's search, progress filters and shortcuts.
// No DOM or storage access here so it can be unit tested directly.

// ─── Search ─────────────────────────────────────────────────────────

// Characters NFKD doesn't decompose into ASCII but that people type
// phonetically ("muse" for μ's).
const FOLD: Record<string, string> = { 'μ': 'mu', 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'ł': 'l' };

/** Lowercase, strip accents, fold full-width forms and katakana to
 *  hiragana, and drop punctuation. Word boundaries collapse to one space so
 *  "Koi ni Naritai AQUARIUM" and "koi-ni-naritai-aquarium" normalize alike. */
export function normalize(s: string): string {
  let out = s.normalize('NFKD').replace(/[̀-゙゚ͯ]/g, '').toLowerCase();
  out = out.replace(/[μßæøł]/g, (c) => FOLD[c] ?? c);
  // Katakana → hiragana so either script finds the other.
  out = out.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // Apostrophes join words ("don't" → "dont"); everything else that isn't a
  // letter or digit in any script becomes a boundary.
  out = out.replace(/['’`]/g, '');
  out = out.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return out.trim();
}

/** Characters of `needle` appear in order in `hay`. Returns a 0..1
 *  tightness score (1 = contiguous) or 0 when it isn't a subsequence. */
function subsequenceScore(needle: string, hay: string): number {
  let hi = 0;
  let first = -1;
  let last = -1;
  for (const ch of needle) {
    const found = hay.indexOf(ch, hi);
    if (found < 0) return 0;
    if (first < 0) first = found;
    last = found;
    hi = found + 1;
  }
  const span = last - first + 1;
  return needle.length / span;
}

/** Score one query token against one normalized field. Higher is better,
 *  0 means no match. Tiers keep "starts with" ahead of "contains" ahead of
 *  fuzzy so ranking feels predictable. */
function scoreToken(token: string, field: string): number {
  if (!field) return 0;
  if (field === token) return 100;
  if (field.startsWith(token)) return 80;
  if (field.includes(' ' + token)) return 60;
  if (field.includes(token)) return 40;
  // Fuzzy: only for tokens long enough that a scattered match is meaningful,
  // otherwise "a" would match every title.
  if (token.length >= 3) {
    const compact = field.replace(/ /g, '');
    const tight = subsequenceScore(token, compact);
    if (tight >= 0.5) return 10 + Math.round(tight * 15);
  }
  return 0;
}

export interface SearchFields {
  name: string;
  nameJp: string;
  id: string;
  album: string;
}

export function searchFields(song: MenuSong): SearchFields {
  return {
    name: normalize(song.name),
    nameJp: normalize(song.name_jp ?? ''),
    id: normalize(song.id),
    album: normalize(song.album ?? ''),
  };
}

// Title matches matter most; album is a fallback so "aozora" still surfaces
// the album tracks without outranking a song literally named that.
const FIELD_WEIGHT: Record<keyof SearchFields, number> = { name: 1, nameJp: 1, id: 0.8, album: 0.4 };

/** Score a song against a query. Every token must hit some field; the
 *  song's score is the sum of each token's best field score. A whole-query
 *  match against the title gets a bonus so exact titles win ties. */
export function scoreSong(fields: SearchFields, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const tokens = q.split(' ');
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const key of Object.keys(FIELD_WEIGHT) as (keyof SearchFields)[]) {
      best = Math.max(best, scoreToken(token, fields[key]) * FIELD_WEIGHT[key]);
    }
    if (best === 0) return 0;
    total += best;
  }
  if (tokens.length > 1) {
    const whole = Math.max(scoreToken(q, fields.name), scoreToken(q, fields.nameJp));
    total += whole;
  }
  return total;
}

export interface RankedSong {
  song: MenuSong;
  score: number;
}

/** Rank songs by query. `boost` lets the caller nudge a subset (the active
 *  group) ahead without hiding the rest. Ties break alphabetically. */
export function rankSongs(
  songs: MenuSong[],
  query: string,
  boost: (s: MenuSong) => number = () => 0,
  fieldCache?: Map<string, SearchFields>,
): RankedSong[] {
  const out: RankedSong[] = [];
  for (const song of songs) {
    let fields = fieldCache?.get(song.id);
    if (!fields) {
      fields = searchFields(song);
      fieldCache?.set(song.id, fields);
    }
    const score = scoreSong(fields, query);
    if (score > 0) out.push({ song, score: score + boost(song) });
  }
  out.sort((a, b) => b.score - a.score || a.song.name.localeCompare(b.song.name));
  return out;
}

// ─── Progress ───────────────────────────────────────────────────────

export type SongStatus = 'unplayed' | 'progress' | 'mastered';

export interface SongProgress {
  plays: number;
  /** Best single-play accuracy over all lines in the song, 0..100. */
  best: number;
  mastered: boolean;
}

/** Fold play history into per-song progress. A play is "mastered" only when
 *  every line in it was right, matching the stats page's star rule. */
export function buildProgress(hist: HistRecord[], songs: MenuSong[]): Map<string, SongProgress> {
  const resolve = playResolver(songs);
  const out = new Map<string, SongProgress>();
  for (const rec of hist) {
    const id = resolve(rec)?.id;
    if (!id) continue;
    const { total, correct } = gradePlay(rec.slots);
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const prev = out.get(id) ?? { plays: 0, best: 0, mastered: false };
    prev.plays++;
    prev.best = Math.max(prev.best, pct);
    prev.mastered = prev.mastered || (total > 0 && correct === total);
    out.set(id, prev);
  }
  return out;
}

/** True when a raw "<songId>-selections" blob holds at least one pick. The
 *  play page saves every slot (empty ones included) as soon as a song is
 *  opened, so a non-empty map alone doesn't mean the player tried it. */
export function hasAnyPick(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const map = JSON.parse(raw) as Record<string, unknown>;
    return Object.values(map).some((v) => Array.isArray(v) && v.length > 0);
  } catch {
    return false;
  }
}

/** A song with saved mid-song picks but no finished play still counts as
 *  started, so it shows under "In progress" rather than "Unplayed". */
export function songStatus(progress: SongProgress | undefined, hasSelections: boolean): SongStatus {
  if (progress?.mastered) return 'mastered';
  if (progress || hasSelections) return 'progress';
  return 'unplayed';
}

export type MenuFilter = 'all' | 'unplayed' | 'progress' | 'mastered' | 'favorites';

export function matchesFilter(filter: MenuFilter, status: SongStatus, favorite: boolean): boolean {
  if (filter === 'all') return true;
  if (filter === 'favorites') return favorite;
  return filter === status;
}

/** Most recently played distinct song ids, newest first. History is
 *  append-only, so array order is play order. */
export function recentSongIds(hist: HistRecord[], songs: MenuSong[], limit: number): string[] {
  const resolve = playResolver(songs);
  const seen: string[] = [];
  for (let i = hist.length - 1; i >= 0 && seen.length < limit; i--) {
    const id = resolve(hist[i])?.id;
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

export function pickRandom<T>(items: T[], rng: () => number = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}
