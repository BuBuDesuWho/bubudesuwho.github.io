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
  return localStorage.getItem(key);
}

export function setStorage(key: string, value: string): boolean {
  if (!hasLocalStorage()) return false;
  localStorage.setItem(key, value);
  return true;
}

export interface HistRecord {
  date: string;
  songName: string;
  slots: [number[], number[]][];
}

export function loadHistory(): HistRecord[] {
  const raw = getStorage('hist') || '[]';
  const arr = JSON.parse(raw) as [string, string, [number[], number[]][]][];
  return arr.map(([date, songName, slots]) => ({ date, songName, slots }));
}

export function saveHistory(record: HistRecord): void {
  const raw = getStorage('hist') || '[]';
  const arr = JSON.parse(raw) as unknown[];
  while (arr.length >= MAXHIST) arr.shift();
  arr.push([record.date, record.songName, record.slots]);
  setStorage('hist', JSON.stringify(arr));
}

export function loadChoicesForSong(songId: string): Record<string, number[]> {
  const raw = getStorage(songId + '-selections') || '{}';
  return JSON.parse(raw);
}

export function saveChoicesForSong(songId: string, choices: Record<string, number[]>): void {
  setStorage(songId + '-selections', JSON.stringify(choices));
}

type HistTuple = [string, string, [number[], number[]][]];

// Profile backup — every key here is something we want to round-trip across
// devices/reinstalls. Keys NOT listed (mastery-cache, buddy-pos/side/size/anim,
// bubudle-current-*, bubudle-flags, sessionStorage) are intentionally excluded
// because they're either derived, device-specific, or ephemeral.
const PROFILE_STATIC_KEYS = new Set<string>([
  // Player progress
  'hist',
  'favorite-member',
  'bubudle-streak',
  // Game preferences (play.html)
  'autoscroll', 'themed', 'hints', 'inline', 'diff', 'calls', 'callSFX', 'jpLyrics', 'lyrics',
  // App-wide preferences
  'theme', 'palette', 'volume',
  // Menu state
  'group', 'sort', 'groupBySubunit',
  // Bubudle settings
  'bubudle-mode', 'bubudle-diff', 'bubudle-sdiff', 'bubudle-daily-scope', 'bubudle-infinite-all',
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

  const raw = getStorage('hist') || '[]';
  const existing = JSON.parse(raw) as HistTuple[];
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
  while (existing.length > MAXHIST) existing.shift();
  setStorage('hist', JSON.stringify(existing));
  return { added, skipped };
}

function isHistTuple(entry: unknown): entry is HistTuple {
  if (!Array.isArray(entry) || entry.length !== 3) return false;
  const [date, songName, slots] = entry;
  if (typeof date !== 'string' || typeof songName !== 'string' || !Array.isArray(slots)) return false;
  for (const slot of slots) {
    if (!Array.isArray(slot) || slot.length !== 2) return false;
    const [chosen, ans] = slot;
    if (!Array.isArray(chosen) || !Array.isArray(ans)) return false;
    if (!chosen.every((n: unknown) => typeof n === 'number')) return false;
    if (!ans.every((n: unknown) => typeof n === 'number')) return false;
  }
  return true;
}
