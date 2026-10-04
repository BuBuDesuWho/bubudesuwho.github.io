const MAXHIST = 10000;

export function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function getStorage(key: string): string | null {
  if (!hasLocalStorage()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** False when the write didn't stick, most often QuotaExceededError once
 *  `hist` grows toward the ~5 MB origin limit. */
export function setStorage(key: string, value: string): boolean {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export interface HistRecord {
  /** Local YYYY-MM-DD; records saved before that carry the browser's
   *  toLocaleDateString(). */
  date: string;
  songName: string;
  /** Missing on records saved before plays were keyed by id. hist.ts falls
   *  back to the name for those. */
  songId?: string;
  slots: [number[], number[]][];
}

// On-disk shape. The song id rides at the end so older builds, which only
// read the first three fields, still understand newer records.
type HistSlots = [number[], number[]][];
type HistTuple = [string, string, HistSlots] | [string, string, HistSlots, string];

function readHistTuples(): HistTuple[] {
  const raw = getStorage('hist');
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isHistTuple) : [];
  } catch {
    return [];
  }
}

function writeHistTuples(arr: HistTuple[]): boolean {
  if (arr.length > MAXHIST) arr.splice(0, arr.length - MAXHIST);
  if (setStorage('hist', JSON.stringify(arr))) return true;
  // Out of quota: shed the oldest tenth and retry once rather than lose the
  // play that just finished.
  arr.splice(0, Math.max(1, Math.ceil(arr.length / 10)));
  return setStorage('hist', JSON.stringify(arr));
}

/** Never throws: corrupt storage reads as empty and malformed records are dropped. */
export function loadHistory(): HistRecord[] {
  return readHistTuples().map(([date, songName, slots, songId]) =>
    songId ? { date, songName, songId, slots } : { date, songName, slots });
}

export function saveHistory(record: HistRecord): boolean {
  const arr = readHistTuples();
  arr.push(record.songId
    ? [record.date, record.songName, record.slots, record.songId]
    : [record.date, record.songName, record.slots]);
  return writeHistTuples(arr);
}

/** Never throws; entries that aren't number arrays are dropped. */
export function loadChoicesForSong(songId: string): Record<string, number[]> {
  const raw = getStorage(songId + '-selections');
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, number[]> = {};
  for (const [key, v] of Object.entries(parsed)) {
    if (isNumberArray(v)) out[key] = v;
  }
  return out;
}

export function saveChoicesForSong(songId: string, choices: Record<string, number[]>): boolean {
  return setStorage(songId + '-selections', JSON.stringify(choices));
}

// ─── Who's singing (rhythm mode) results ───────────────────────────
// Kept apart from `hist` on purpose: rhythm-mode guesses don't count toward
// the quiz's guesses or mastery. One entry per song: the latest run, and the
// best uninterrupted full run.
export interface WhosingsRun {
  correct: number;
  attempted: number;
  total: number;
  /** Part of the song was skipped (scrubbed or started partway). */
  partial: boolean;
  diff: number;
  date: string;
  /** Rhythm score and longest combo; missing on runs saved before scoring. */
  score?: number;
  maxCombo?: number;
}
export type WhosingsResults = Record<string, { last: WhosingsRun; best?: WhosingsRun }>;

export function loadWhosingsResults(): WhosingsResults {
  try {
    return JSON.parse(getStorage('whosings-results') || '{}') as WhosingsResults;
  } catch {
    return {};
  }
}

/** Full runs only; more right lines wins, and the score breaks a tie. */
export function isBetterWhosingsRun(run: WhosingsRun, prev: WhosingsRun | undefined): boolean {
  if (run.partial) return false;
  if (!prev) return true;
  if (run.correct !== prev.correct) return run.correct > prev.correct;
  return (run.score ?? 0) > (prev.score ?? 0);
}

export function saveWhosingsRun(songId: string, run: WhosingsRun): void {
  const all = loadWhosingsResults();
  const prev = all[songId]?.best;
  all[songId] = { last: run, best: isBetterWhosingsRun(run, prev) ? run : prev };
  setStorage('whosings-results', JSON.stringify(all));
}

// ─── Mastery cache ──────────────────────────────────────────────────
// Derived snapshot written by the stats page and read by the buddy on other
// pages. One shape, shared by both ends — so a field rename breaks the build
// instead of silently yielding NaN%/0 in the buddy. (Not in PROFILE_STATIC_KEYS:
// it's derived from `hist` and rebuilt on each stats-page render.)
export interface MasteryCacheEntry {
  group: string;
  id: number;
  correct: number;
  attempted: number;
  totalLines: number;
}

/** Mastery percentage from a correct/total pair: 0 when there's nothing to
 *  divide by, otherwise the rounded ratio clamped to 100. One formula shared
 *  by the stats dials and the buddy badge so the two can't drift. (Callers
 *  pre-clamp `correct <= total`, so the 100 ceiling is a guard, not a change.) */
export function masteryPct(correct: number, total: number): number {
  return total < 1 ? 0 : Math.min(100, Math.round((correct / total) * 100));
}

export function saveMasteryCache(entries: MasteryCacheEntry[]): void {
  setStorage('mastery-cache', JSON.stringify(entries));
}

export function loadMasteryCache(): MasteryCacheEntry[] {
  const raw = getStorage('mastery-cache');
  if (!raw) return [];
  try {
    return JSON.parse(raw) as MasteryCacheEntry[];
  } catch {
    return [];
  }
}

// Profile backup — every key here is something we want to round-trip across
// devices/reinstalls. Keys NOT listed (mastery-cache, buddy-pos/side/size/anim,
// bubudle-current-*, bubudle-flags, sessionStorage) are intentionally excluded
// because they're either derived, device-specific, or ephemeral.
const PROFILE_STATIC_KEYS = new Set<string>([
  // Player progress
  'hist',
  'whosings-results',
  'favorite-member',
  'bubudle-streak',
  // Game preferences (play.html)
  'autoscroll', 'themed', 'hints', 'inline', 'diff', 'calls', 'callSFX', 'jpLyrics', 'lyrics',
  'playbackRate',
  // App-wide preferences
  'theme', 'palette', 'volume',
  // Menu state
  'group', 'sort', 'groupBy', 'groupBySubunit', 'menu-filter', 'fav-songs',
  // Bubudle settings
  'bubudle-mode', 'bubudle-diff', 'bubudle-sdiff', 'bubudle-daily-scope', 'bubudle-infinite-all',
  'bubudle-count-progress',
]);

function shouldExportKey(key: string): boolean {
  if (PROFILE_STATIC_KEYS.has(key)) return true;
  if (key.endsWith('-selections')) return true;          // <songId>-selections
  if (key.startsWith('bubudle-daily-')) return true;     // bubudle-daily-<scope>-<date>
  if (key.startsWith('bubudle-subunits-')) return true;  // bubudle-subunits-<group>
  return false;
}

export interface ProfileExport {
  kind: 'bubudesuwho-profile';
  version: 1;
  exportedAt: string;
  mode: 'anime' | 'kpop';
  keyCount: number;
  data: Record<string, string>;
}

export function exportProfileDoc(mode: 'anime' | 'kpop'): ProfileExport {
  const data: Record<string, string> = {};
  if (hasLocalStorage()) {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !shouldExportKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      data[key] = value;
    }
  }
  return {
    kind: 'bubudesuwho-profile',
    version: 1,
    exportedAt: new Date().toISOString(),
    mode,
    keyCount: Object.keys(data).length,
    data,
  };
}

export interface ProfileImportResult {
  histAdded: number;
  histSkipped: number;
  prefsReplaced: number;
  ignored: number;
}

// Restore a profile backup. `hist` is merged (dedupe by exact record); every
// other allow-listed key is replaced with the imported value. Keys absent
// from the import are left alone. Throws on schema mismatch so the UI can
// surface a useful error.
export function importProfileDoc(doc: unknown): ProfileImportResult {
  if (!doc || typeof doc !== 'object') throw new Error('File is not a JSON object.');
  const obj = doc as { kind?: unknown; data?: unknown };
  if (obj.kind !== 'bubudesuwho-profile') throw new Error('Not a BubuDesuWho profile file.');
  if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
    throw new Error('Missing "data" object.');
  }
  const data = obj.data as Record<string, unknown>;

  const result: ProfileImportResult = { histAdded: 0, histSkipped: 0, prefsReplaced: 0, ignored: 0 };
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') { result.ignored++; continue; }
    if (!shouldExportKey(key)) { result.ignored++; continue; }
    if (key === 'hist') {
      const merged = mergeHistRaw(value);
      result.histAdded = merged.added;
      result.histSkipped = merged.skipped;
    } else {
      setStorage(key, value);
      result.prefsReplaced++;
    }
  }
  return result;
}

function mergeHistRaw(incomingRaw: string): { added: number; skipped: number } {
  let incoming: unknown;
  try { incoming = JSON.parse(incomingRaw); }
  catch { throw new Error('Bad hist payload (invalid JSON).'); }
  if (!Array.isArray(incoming)) throw new Error('Bad hist payload (not an array).');

  const existing = readHistTuples();
  const seen = new Set(existing.map(e => JSON.stringify(e)));
  let added = 0;
  let skipped = 0;
  for (const entry of incoming) {
    if (!isHistTuple(entry)) throw new Error('Bad hist entry shape.');
    const key = JSON.stringify(entry);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    existing.push(entry);
    added++;
  }
  if (!writeHistTuples(existing)) throw new Error('Not enough storage space to save the imported plays.');
  return { added, skipped };
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number');
}

function isHistTuple(entry: unknown): entry is HistTuple {
  if (!Array.isArray(entry) || (entry.length !== 3 && entry.length !== 4)) return false;
  const [date, songName, slots, songId] = entry;
  if (typeof date !== 'string' || typeof songName !== 'string' || !Array.isArray(slots)) return false;
  if (entry.length === 4 && typeof songId !== 'string') return false;
  for (const slot of slots) {
    if (!Array.isArray(slot) || slot.length !== 2) return false;
    if (!isNumberArray(slot[0]) || !isNumberArray(slot[1])) return false;
  }
  return true;
}
