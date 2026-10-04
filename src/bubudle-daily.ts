import { GroupName } from './types';
import { getStorage, setStorage } from './storage';

export type AppMode = 'anime' | 'kpop';

export type DailyScope =
  | { kind: 'group'; group: GroupName }
  | { kind: 'mode'; mode: AppMode };

export interface DailyResult {
  guesses: string[];
  correct: boolean;
  songId: string;
  range: [number, number];
  wrongCount: number;
  /** Played from the archive after the day had passed; kept out of streaks and win %. */
  archive?: boolean;
}

export function scopeKey(scope: DailyScope): string {
  return scope.kind === 'group' ? `group:${scope.group}` : `mode:${scope.mode}`;
}

const EST_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const EST_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Today's date in America/New_York as YYYY-MM-DD. */
export function currentDateEst(now: Date = new Date()): string {
  return EST_DATE_FMT.format(now);
}

/** Earliest daily the archive can serve — the day Daily mode shipped. */
export const ARCHIVE_START = '2026-04-25';

/**
 * First day picked by the no-repeat rotation. Everything before this was served
 * by the old independent draw and is pinned in the manifest, so history is
 * untouched by the change; 2026-08-25's daily was already generated and posted.
 */
export const ROTATION_START = '2026-08-26';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a YYYY-MM-DD as UTC midnight, so day arithmetic never crosses a zone. */
function asUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Shift a YYYY-MM-DD by whole days, staying in calendar space. */
export function shiftDate(date: string, days: number): string {
  const d = asUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Clamp an untrusted ?date= to a daily that actually exists. ISO dates are
 * zero-padded, so lexical compare is chronological. Malformed, future, or
 * pre-archive values fall back to `today`.
 */
export function clampDailyDate(raw: string | null, today: string, start = ARCHIVE_START): string {
  if (!raw || !ISO_DATE.test(raw)) return today;
  if (raw > today || raw < start) return today;
  // Shape-valid but impossible calendar dates (2026-02-31) round-trip differently.
  const d = asUtc(raw);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return today;
  return raw;
}

const ARCHIVE_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "2026-08-24" → "Mon, Aug 24, 2026" for the archive banner. */
export function formatDailyDate(date: string): string {
  return ARCHIVE_LABEL_FMT.format(asUtc(date));
}

/** Milliseconds until the next 00:00:00 in America/New_York. */
export function msUntilNextEstMidnight(now: Date = new Date()): number {
  const parts = EST_PARTS_FMT.formatToParts(now);
  const get = (t: string): number => parseInt(parts.find(p => p.type === t)!.value, 10);
  const h = get('hour') % 24;
  const m = get('minute');
  const s = get('second');
  const elapsedToday = ((h * 60) + m) * 60 + s;
  const remaining = 24 * 60 * 60 - elapsedToday;
  return remaining * 1000 - (now.getTime() % 1000);
}

/** cyrb53 — small, well-distributed string hash. Returns a 53-bit integer. */
export function seedFromString(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function pickDailyIndex(scope: DailyScope, date: string, length: number): number {
  if (length <= 0) return 0;
  return seedFromString(`${scopeKey(scope)}|${date}`) % length;
}

export function formatHms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function dailyStorageKey(scope: DailyScope, date: string): string {
  return `bubudle-daily-${scopeKey(scope)}-${date}`;
}

export function loadDailyResult(scope: DailyScope, date: string): DailyResult | null {
  const raw = getStorage(dailyStorageKey(scope, date));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DailyResult;
    if (!Array.isArray(parsed.guesses) || typeof parsed.songId !== 'string') return null;
    return parsed;
  } catch { return null; }
}

export function saveDailyResult(scope: DailyScope, date: string, result: DailyResult): void {
  setStorage(dailyStorageKey(scope, date), JSON.stringify(result));
}
