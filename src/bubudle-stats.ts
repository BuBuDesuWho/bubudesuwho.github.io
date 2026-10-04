// Daily Bubudle stats, derived from the per-day results already in storage
// rather than a separate counter, so they can't drift from what the board
// shows and profile export/import carries them for free.

import { DailyResult, DailyScope, scopeKey, shiftDate } from './bubudle-daily';
import { MAX_ATTEMPTS } from './bubudle-share';
import { hasLocalStorage } from './storage';

export interface DatedResult {
  date: string;
  result: DailyResult;
}

export interface DailyStats {
  played: number;
  wins: number;
  /** Rounded 0-100. */
  winPct: number;
  currentStreak: number;
  maxStreak: number;
  /** distribution[i] = wins in i + 1 guesses; length MAX_ATTEMPTS. */
  distribution: number[];
  losses: number;
  /** Old dailies played from the archive; shown, but kept out of the numbers above. */
  archivePlayed: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Results saved before the archive flag existed are treated as live: the
// archive is newer than most history, and over-counting a few old replays
// beats wiping everyone's streak.
function isLive(r: DailyResult): boolean {
  return !r.archive;
}

export function computeDailyStats(entries: DatedResult[], today: string): DailyStats {
  const live = entries.filter((e) => isLive(e.result)).sort((a, b) => a.date.localeCompare(b.date));
  const distribution = new Array<number>(MAX_ATTEMPTS).fill(0);
  let wins = 0;
  for (const { result } of live) {
    if (!result.correct) continue;
    wins++;
    const n = Math.min(Math.max(result.guesses.length, 1), MAX_ATTEMPTS);
    distribution[n - 1]++;
  }

  let maxStreak = 0;
  let run = 0;
  let prevDate: string | null = null;
  for (const { date, result } of live) {
    if (!result.correct) { run = 0; prevDate = date; continue; }
    run = prevDate !== null && shiftDate(prevDate, 1) === date && run > 0 ? run + 1 : 1;
    maxStreak = Math.max(maxStreak, run);
    prevDate = date;
  }

  // An unplayed today doesn't break the streak yet; it's still yours to keep.
  const byDate = new Map(live.map((e) => [e.date, e.result]));
  let cursor = byDate.has(today) ? today : shiftDate(today, -1);
  let currentStreak = 0;
  while (byDate.get(cursor)?.correct) {
    currentStreak++;
    cursor = shiftDate(cursor, -1);
  }

  const played = live.length;
  return {
    played,
    wins,
    winPct: played === 0 ? 0 : Math.round((wins / played) * 100),
    currentStreak,
    maxStreak,
    distribution,
    losses: played - wins,
    archivePlayed: entries.length - live.length,
  };
}

/** Every stored daily result for a scope, keyed off `bubudle-daily-<scope>-<date>`. */
export function loadScopeResults(scope: DailyScope): DatedResult[] {
  if (!hasLocalStorage()) return [];
  const prefix = `bubudle-daily-${scopeKey(scope)}-`;
  const out: DatedResult[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const date = key.slice(prefix.length);
    if (!ISO_DATE.test(date)) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '') as DailyResult;
      if (Array.isArray(parsed.guesses) && typeof parsed.correct === 'boolean') out.push({ date, result: parsed });
    } catch { /* a corrupt day just doesn't count */ }
  }
  return out;
}
